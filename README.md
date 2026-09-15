# Shopee Taiwan Scraper API

REST API (TypeScript) yang mengambil data detail produk dari Shopee Taiwan (`get_pc`/`get_rw`) dengan pendekatan **hybrid**: browser headless (Playwright + stealth) dipakai jarang untuk membangun sesi/cookie/header yang valid, sedangkan mayoritas request produk dilayani lewat HTTP client ringan (axios) yang menggunakan ulang sesi tersebut — menyeimbangkan ketahanan terhadap anti-bot dengan skalabilitas.

> **Status:** Kode lengkap, type-check/lint/build bersih, dan **terbukti berhasil sekali secara end-to-end** mengambil data produk asli lengkap sesuai skema `get_pc`. Setelah itu, dua item contoh yang dipakai berulang kali selama development memicu sistem anti-bot Shopee (`/verify/traffic/error`, kode `90309999`) yang terbukti persisten lintas IP/jaringan/proxy (lihat [Metode & Eksperimen yang Dicoba](#metode--eksperimen-yang-dicoba) — 9 pendekatan didokumentasikan). Setelah itu, dua review analisis independen (lihat [Analisis Eksternal & Perbaikan Lanjutan](#analisis-eksternal--perbaikan-lanjutan)) menghasilkan perbaikan lanjutan: klasifikasi error granular, circuit breaker per produk, sticky-proxy-per-sesi (bug nyata yang diperbaiki), in-browser fetch untuk eliminasi TLS mismatch, dan load test dengan ramp-up bertahap. Arsitektur sudah mengimplementasikan praktik standar untuk high-quality scraping; uji volume 200+ item yang konsisten kemungkinan besar butuh item/produk yang belum pernah "dibakar" testing berulang dan/atau proxy residential premium.

## Daftar Isi

- [Arsitektur](#arsitektur)
- [Setup & Menjalankan Lokal](#setup--menjalankan-lokal)
- [Konfigurasi Proxy](#konfigurasi-proxy)
- [Penggunaan API](#penggunaan-api)
- [Teknik Anti-Deteksi](#teknik-anti-deteksi)
- [Mode Guest vs Login (`AUTH_MODE`)](#mode-guest-vs-login-auth_mode)
- [Load Test / Uji Stabilitas](#load-test--uji-stabilitas)
- [Hosting via Ngrok](#hosting-via-ngrok)
- [Metode & Eksperimen yang Dicoba](#metode--eksperimen-yang-dicoba)
- [Analisis Eksternal & Perbaikan Lanjutan](#analisis-eksternal--perbaikan-lanjutan)
- [Batasan yang Diketahui](#batasan-yang-diketahui)

## Arsitektur

```text
Client → GET /shopee?storeId=&dealId=
           │
           ▼
   validateQuery middleware
           │
           ▼
   shopee.client.ts ── rateLimiter (concurrency + jitter)
           │                 │
           │                 ▼
           │           retry.ts (backoff; anti-bot → refresh session)
           │
           ├─→ session.manager.ts (Playwright headless, stealth plugin)
           │      → buka https://shopee.tw/a-i.{storeId}.{dealId}
           │      → tangkap cookie & header asli dari request get_pc/get_rw browser
           │      → cache sesi (TTL, default 10 menit)
           │
           └─→ axios GET ke api/v4/pdp/get_pc (fallback get_rw)
                  menggunakan cookie & header hasil capture browser
                  + proxy opsional (proxy.manager.ts)
                  → return JSON asli, passthrough tanpa transformasi
```

Struktur folder:

```text
src/
  server.ts               Express app + graceful shutdown
  routes/shopee.route.ts  GET /shopee
  services/
    session.manager.ts    Bootstrap & cache sesi via Playwright
    shopee.client.ts      HTTP client ke get_pc/get_rw
    proxy.manager.ts       Proxy rotation (pluggable, no-op by default)
  lib/
    rateLimiter.ts         Concurrency limiter + jitter delay
    retry.ts               Retry per-tipe error, kebijakan berbeda per ScrapeErrorType
    errors.ts              ScrapeError + 9 tipe error terklasifikasi
    logger.ts              Structured logging (pino)
  middleware/
    validateQuery.ts
    errorHandler.ts
  types/shopee.ts          Tipe ShopeeSession, ShopeeProductParams
  techniques/              12 teknik anti-deteksi sebagai modul standalone (lihat index.ts)
scripts/
  setup-browser.js         Download & stage Chrome for Testing untuk rebrowser-playwright
test/
  loadtest.ts              Script uji volume & stabilitas
  targets.example.json     Contoh daftar storeId/dealId
```

## Setup & Menjalankan Lokal

Prasyarat: Node.js ≥ 20.

```bash
npm install
npm run setup:browser             # download & stage Chrome for Testing untuk rebrowser-playwright (macOS)
cp .env.example .env              # lalu isi PROXY_LIST jika punya proxy (lihat bawah)
npm run dev                       # jalankan di http://localhost:3000
```

> Catatan: proyek ini pakai `rebrowser-playwright` (bukan `playwright` biasa) agar Chromium yang dikontrol otomatis tidak mudah dideteksi lewat jejak Chrome DevTools Protocol. Installer bawaannya (`npx playwright install`) bentrok dengan paket `playwright` yang ter-hoist npm, jadi `npm run setup:browser` mengunduh build Chrome for Testing yang sesuai secara langsung dan menaruhnya di `~/Library/Caches/rebrowser-chromium-manual` (macOS only — untuk platform lain, install manual & set `CHROME_EXECUTABLE_PATH` di `.env`).

Cek server hidup:

```bash
curl http://localhost:3000/health
```

Build produksi:

```bash
npm run build
npm start
```

## Konfigurasi Proxy

Proxy **tidak wajib** untuk menjalankan API (default: request langsung dari IP mesin/ngrok Anda), tapi sangat disarankan untuk volume tinggi & mengurangi risiko rate-limit/block dari Shopee. Ada dua mode:

```bash
PROXY_MODE=sticky              # default
PROXY_LIST=http://user:pass@host1:port,http://user:pass@host2:port

# atau
PROXY_MODE=rotating
PROXY_ROTATING_LIST=http://user:pass@host1:port,http://user:pass@host2:port
```

- **`sticky`** (default): IP yang sama dipertahankan sepanjang siklus hidup satu sesi (bootstrap Playwright + request axios susulan ke produk yang sama) — ini **wajib**, karena cookie/token Shopee terikat ke IP; kalau IP berubah di tengah sesi, sesi jadi tidak valid.
- **`rotating`**: IP baru setiap kali `proxyManager.getProxy()` dipanggil — cocok untuk menyebar beban antar sesi/produk yang **berbeda**, tapi jangan dipakai kalau provider Anda butuh kontinuitas IP per sesi.
- Kosongkan `PROXY_LIST`/`PROXY_ROTATING_LIST` untuk jalan tanpa proxy.
- Beberapa proxy dipisah koma akan dipakai round-robin dalam mode yang aktif; proxy yang gagal berulang kali (≥3x) otomatis di-disable sementara (5 menit) lalu dicoba lagi.
- Rekomendasi sumber proxy residential dengan geo-targeting Taiwan: [DataImpulse](https://dataimpulse.com), [IPRoyal](https://iproyal.com). **Penting:** untuk provider yang mendukung sticky/rotating lewat port berbeda (mis. DataImpulse: port `10000` = sticky, `823` = rotating), pastikan port di URL proxy Anda sesuai dengan `PROXY_MODE` yang dipilih.

## Penggunaan API

### `GET /shopee?storeId={storeId}&dealId={dealId}`

Mengambil dan mengembalikan **response asli** Shopee `get_pc` (fallback `get_rw` bila `get_pc` tidak mengembalikan item valid).

Contoh:

```bash
curl "http://localhost:3000/shopee?storeId=178926468&dealId=21448123549"
```

Response sukses (200): JSON identik dengan struktur `get_pc` Shopee (lihat `.docs/get_pc.response_example.txt` untuk referensi skema lengkap — `item`, `shop_detailed`, `product_shipping`, `product_review`, dll).

Response gagal:

- `400` — `storeId`/`dealId` tidak valid (harus numerik).
- `502` — gagal mengambil data dari Shopee setelah seluruh retry habis (lihat field `message` untuk detail penyebab).

### `GET /health`

Health check sederhana, mengembalikan `{ "status": "ok" }`.

## Teknik Anti-Deteksi

Sebagian besar teknik yang bisa dipilih (bukan arsitektur inti) diimplementasikan sebagai modul standalone di `src/techniques/` (`browserEngine.ts`, `languageInterstitial.ts`, `navigationWarmup.ts`, `resourceBlocking.ts`, `trafficWallDetector.ts`, `circuitBreaker.ts`, `fallbackEndpoint.ts`) — lihat `src/techniques/index.ts` untuk daftar lengkap & env var mana yang mengaktifkan tiap teknik. Ini memudahkan kombinasi/isolasi teknik untuk eksperimen lanjutan tanpa perlu mengubah logika inti `session.manager.ts`.

1. **Sesi & header dari browser asli, bukan ditiru manual.** `session.manager.ts` membuka halaman produk lewat Playwright (dengan `puppeteer-extra-plugin-stealth`, yang menutupi indikator umum automation seperti `navigator.webdriver`, inkonsistensi plugin/permissions, dsb) dan menyadap (`page.on("request")`) header **yang benar-benar dikirim browser** ke endpoint `get_pc`/`get_rw`, termasuk signature dinamis Shopee (mis. `af-ac-enc-dat`, `x-api-source`) yang sulit dipalsukan manual. Ini menghindari kebutuhan reverse-engineer algoritma signature Shopee secara statis, yang rawan basi ketika Shopee mengubah implementasinya.
2. **`rebrowser-playwright` alih-alih Playwright standar (`BROWSER_ENGINE`, lihat `src/techniques/browserEngine.ts`).** Playwright biasa (bahkan dengan stealth plugin) tetap meninggalkan jejak yang bisa dideteksi lewat cara ia memakai Chrome DevTools Protocol (mis. leak dari `Runtime.enable`) — vektor deteksi yang sudah dikenal luas dan tidak ditutupi stealth plugin generik. `rebrowser-playwright` adalah fork Playwright yang di-patch khusus untuk menghilangkan jejak CDP tersebut. Bisa dipilih 4 kombinasi: `rebrowser` (default), `vanilla-stealth` (Playwright biasa + stealth, untuk isolasi variabel patch CDP), `vanilla` (baseline awal yang gagal), atau `patchright` (lihat catatan riset di [Batasan yang Diketahui](#batasan-yang-diketahui) — patch CDP yang lebih menyeluruh dari `rebrowser-playwright`, tetap tidak menembus deteksi Shopee saat ini).
3. **Penanganan interstitial pemilihan bahasa.** Navigasi pertama ke `shopee.tw` bisa menampilkan popup pilih bahasa/wilayah untuk visitor baru, yang kalau tidak ditangani akan memblokir halaman produk asli (dan `get_pc`) untuk pernah dimuat. Kode menyuntik cookie preferensi bahasa lebih dulu, dan sebagai fallback mencoba klik opsi Bahasa Mandarin Tradisional/Taiwan bila popup tetap muncul.
4. **Reuse sesi per-produk, bukan browser-per-request.** Sesi (cookie + header) di-cache **per `storeId`+`dealId`** dengan TTL (`SESSION_REFRESH_INTERVAL_MS`, default 10 menit) dan dipakai ulang untuk request berikutnya ke produk yang sama lewat HTTP client ringan (axios). Pengujian menunjukkan sesi Shopee terikat erat ke halaman produk yang dinavigasi (kemungkinan lewat referer/token yang tervalidasi silang), sehingga sesi **tidak** di-share lintas produk berbeda — tiap produk baru tetap butuh satu navigasi Playwright untuk bootstrap sesi, tapi request berulang ke produk yang sama dalam TTL tetap ringan lewat axios.
5. **Rate limiting alami.** `rateLimiter.ts` membatasi concurrency (default 4 request paralel) dan menambahkan jeda acak (jitter, default 300–1500ms) antar request, agar pola waktu request tidak terlihat mekanis seperti bot flood.
6. **Retry berbasis klasifikasi error (`src/lib/errors.ts`).** Setiap kegagalan dinormalisasi jadi salah satu dari 9 tipe (`NETWORK_ERROR`, `TIMEOUT`, `HTTP_403`, `HTTP_429`, `TRAFFIC_VERIFICATION`, `INVALID_RESPONSE`, `SESSION_EXPIRED`, `PROXY_FAILURE`, `BROWSER_FAILURE`), masing-masing dengan kebijakan retry sendiri di `retry.ts`. **Penting:** `TRAFFIC_VERIFICATION` sengaja diberi **0 retry** — refresh sesi lalu mencoba lagi setelah kena wall anti-bot diduga justru **memperparah** risk/velocity score (bukan menyelesaikannya), sesuai temuan analisis eksternal di `.docs/`. Sebaliknya, sesi & produk tersebut langsung ditandai `blocked` dengan cooldown (`BLOCKED_COOLDOWN_MS`, default 5 menit) sebelum boleh dicoba lagi.
7. **Proxy rotation (opsional, pluggable).** `proxy.manager.ts` mendukung daftar proxy yang dirotasi round-robin, dengan proxy yang sering gagal otomatis dikarantina sementara — mengurangi ketergantungan pada satu IP keluar.
8. **Fallback endpoint.** Jika `get_pc` tidak mengembalikan item (null/error), otomatis dicoba `get_rw` sebagai cadangan.
9. **Resource blocking di Playwright (opsional, `BLOCK_STATIC_ASSETS=true`).** Karena hanya butuh JSON `get_pc`/`get_rw`, gambar/font/stylesheet bisa diblokir saat bootstrap untuk memangkas bandwidth ~60-80% (berguna untuk biaya proxy per-GB). **Default: mati** — elemen `<img>`/font yang tidak pernah selesai load bisa jadi sinyal deteksi tersendiri bagi JS anti-bot Shopee (browser manusia asli selalu menyelesaikan load-nya), jadi hanya aktifkan setelah kualitas IP/proxy sudah terbukti cukup baik dengan sendirinya.
10. **Sticky proxy konsisten per-sesi (bug fix).** Sebelumnya, browser (Playwright) dan HTTP client (axios) masing-masing memanggil `proxyManager.getProxy()` secara independen — dengan >1 proxy di `PROXY_LIST`, keduanya bisa saja keluar lewat **IP berbeda** dalam satu sesi yang sama, padahal cookie/token Shopee terikat ke IP. Sekarang proxy dipilih **sekali per bootstrap** dan disimpan di `session.proxyUrl`, lalu dipakai ulang secara konsisten oleh axios (atau in-browser fetch) untuk sesi itu.
11. **In-browser fetch (default aktif, `IN_BROWSER_FETCH=true`).** Alih-alih replay lewat axios (TLS/HTTP2 stack Node.js — berpotensi mismatch dengan fingerprint Chromium yang menerbitkan sesi), `get_pc`/`get_rw` dipanggil langsung lewat `page.evaluate(fetch(...))` di dalam konteks Chromium asli. Ini meniadakan variabel fingerprint TLS/HTTP2 sepenuhnya untuk request berulang, bukan cuma untuk request pertama. **Alasan diubah jadi default (bukan lagi opsional):** dokumentasi teknis publik tentang mekanisme anti-fraud Shopee (header signature `x-sap-ri` dkk.) menyebutkan signature per-request terikat ke *sequence counter* di sisi device yang hanya bertambah benar ketika fetch dieksekusi oleh instance browser yang sama yang memegang sesi tersebut — replay `axios` di luar browser, walau headernya hasil capture asli, berisiko dianggap "out-of-sequence" begitu counter itu tidak sinkron. Ini cocok dengan pola yang teramati sepanjang project ini: request pertama (dari browser) sering berhasil, replay berikutnya (via axios) yang gagal. Set `IN_BROWSER_FETCH=false` untuk kembali ke axios (lebih cepat, tapi sesuai analisis di atas berisiko makin sering gagal setelah request pertama dalam satu sesi).
12. **Circuit breaker per-produk.** Begitu satu produk kena `/verify/traffic/error`, sesi & produk itu langsung ditandai `blocked` dan di-cooldown (`BLOCKED_COOLDOWN_MS`) — request berikutnya ke produk yang sama akan gagal cepat tanpa membuka browser baru, alih-alih terus menghantam produk yang sudah ter-flag.

### Cara Memilih/Mengombinasikan Teknik

Teknik #2, #7, #9, #11, dan bonus persistent-profile **opsional** dan dipilih lewat env var — kombinasikan sesuai kebutuhan eksperimen. Teknik lainnya (#1, #3-6, #8, #10, #12) selalu aktif (bagian arsitektur inti).

| Env Var | Nilai | Teknik | Default |
|---|---|---|---|
| `BROWSER_ENGINE` | `rebrowser` \| `vanilla-stealth` \| `vanilla` \| `patchright` | #2 — engine browser + stealth | `rebrowser` |
| `NAVIGATION_STRATEGY` | `direct` \| `warmup` | #7 — navigasi warm-up homepage dulu | `direct` |
| `BLOCK_STATIC_ASSETS` | `true` \| `false` | #9 — resource blocking | `false` |
| `IN_BROWSER_FETCH` | `true` \| `false` | #11 — fetch lewat `page.evaluate()` | `true` |
| `PERSISTENT_PROFILE` | `true` \| `false` | bonus — profil browser persisten | `false` |
| `BLOCKED_COOLDOWN_MS` | angka (ms) | #12 — durasi cooldown circuit breaker | `300000` (5 menit) |
| `SESSION_REFRESH_INTERVAL_MS` | angka (ms) | #4 — TTL cache sesi per-produk | `600000` (10 menit) |

**Contoh penggunaan** (langsung sebagai prefix env var sebelum command, atau isi di `.env`):

```bash
# Default: rebrowser + in-browser fetch, tanpa warm-up (rekomendasi produksi)
npm run dev

# Isolasi variabel: uji apakah patch CDP rebrowser yang berpengaruh, tanpa stealth plugin bawaan lain
BROWSER_ENGINE=vanilla-stealth npm run dev

# Nonaktifkan in-browser fetch, kembali ke axios (lebih cepat, tapi lebih rawan gagal setelah request pertama per sesi)
IN_BROWSER_FETCH=false npm run dev

# Kombinasi "paling defensif": warm-up navigasi + in-browser fetch (default) + profil persisten
NAVIGATION_STRATEGY=warmup PERSISTENT_PROFILE=true npm run dev

# Uji baseline lama (method #1 di tabel eksperimen) untuk komparasi — biasanya gagal cepat
BROWSER_ENGINE=vanilla npm run dev

# Hemat bandwidth proxy (resource blocking) di atas default in-browser fetch
BLOCK_STATIC_ASSETS=true npm run dev

# Perpendek cooldown circuit breaker jadi 1 menit untuk testing cepat (jangan dipakai di produksi)
BLOCKED_COOLDOWN_MS=60000 npm run dev
```

Semua kombinasi bisa juga ditulis permanen di `.env` (lihat `.env.example` untuk daftar lengkap + penjelasan tiap opsi). Untuk peta teknik → file kode → env var secara terprogram, lihat komentar di `src/techniques/index.ts`.

## Mode Guest vs Login (`AUTH_MODE`)

Sesuai temuan di bagian [Batasan yang Diketahui](#batasan-yang-diketahui), Shopee saat ini membatasi akses **guest/anonim** secara luas — bukan cuma untuk scraper otomatis, tapi juga terkonfirmasi lewat browsing manual manusia. Untuk mengakomodasi kedua skenario tanpa mengubah asumsi cakupan tugas (guest-only tetap default), tersedia dua mode lewat `AUTH_MODE`:

| `AUTH_MODE` | Perilaku | Default |
|---|---|---|
| `guest` | Sesi bootstrap dari context browser kosong/anonim — sesuai cakupan awal tugas (scraping publik, tanpa akun). | ✅ Default |
| `login` | Sesi bootstrap dengan memuat *storage state* (cookies + localStorage) dari login yang sudah dilakukan sebelumnya. | — |

**Penting: login form tidak pernah diotomasi oleh kode ini.** Proses login (termasuk OTP/captcha apa pun yang diminta Shopee) selalu dilakukan manusia secara manual, satu kali, lewat browser asli yang dibuka `npm run login` — bukan diisi otomatis oleh skrip. Ini mengurangi risiko akun (tidak ada credential-stuffing/scripted-login yang bisa memicu deteksi tambahan) dan menghindari kebutuhan menyimpan password mentah di mana pun dalam kode/`.env`.

**Cara pakai mode login:**

```bash
# 1. Login manual satu kali (membuka browser asli, biarkan Anda login termasuk OTP/captcha)
npm run login
# atau target region lain:
SHOPEE_DOMAIN=shopee.co.id npm run login

# Setelah login selesai di browser yang terbuka, tekan Enter di terminal.
# Session (cookies + localStorage) tersimpan ke .auth/shopee-login-state.json (gitignored).

# 2. Jalankan server dengan sesi yang sudah login
AUTH_MODE=login npm run dev
```

Jika `AUTH_MODE=login` diset tapi file storage state belum ada (belum pernah `npm run login`), sistem otomatis fallback ke mode `guest` dengan warning log — tidak crash.

**Catatan risiko & cakupan:** mode `login` disediakan untuk **keperluan validasi/riset** (mis. mengisolasi apakah akses guest vs akses ter-otentikasi memengaruhi hasil `get_pc`), bukan rekomendasi default untuk production run bervolume tinggi — akun pribadi yang dipakai untuk 200+ request otomatis dalam waktu singkat berisiko kena flag/pembatasan oleh Shopee, terlepas dari teknik anti-deteksi apa pun yang dipakai. File `.auth/shopee-login-state.json` berisi cookies sesi aktif — perlakukan seperti password, jangan pernah di-commit (sudah masuk `.gitignore`).

## Load Test / Uji Stabilitas

Untuk memenuhi kriteria 200+ item dengan error rate <10% dan stabil selama uji berkelanjutan:

```bash
# Jalankan server di terminal terpisah: npm run dev

# Uji 200 request (default), concurrency 4
npm run loadtest

# Uji berbasis durasi (mis. 60 menit) alih-alih jumlah tetap
DURATION_MINUTES=60 npm run loadtest

# Ramp-up bertahap (RECOMMENDED): 1 → 5 → 10 → 25 → 50 → 100 → 200 request,
# berhenti otomatis kalau satu stage error rate-nya >50% (hindari terus menambah
# beban ke target yang sudah jelas bermasalah)
RAMP_UP=true npm run loadtest
RAMP_UP=true RAMP_STAGES=1,5,10,25,50,100,200 RAMP_PAUSE_MS=5000 npm run loadtest

# Sesuaikan concurrency / total request
TOTAL_REQUESTS=250 CONCURRENCY=5 npm run loadtest
```

Script membaca target dari `test/targets.json` (fallback ke `test/targets.example.json` bila belum ada). **Untuk uji nyata 200+ item, buat `test/targets.json` berisi 200+ pasangan `{storeId, dealId}` produk berbeda** — daftar contoh hanya berisi 2 produk untuk demo cepat.

Output berupa ringkasan: total request, sukses/gagal, error rate, rata-rata latency, dan status PASS/FAIL terhadap kriteria.

## Hosting via Ngrok

```bash
# Terminal 1
npm run build && npm start
# atau: npm run dev

# Terminal 2
ngrok http 3000
```

Salin URL publik dari Ngrok (mis. `https://xxxx.ngrok-free.app`) dan gunakan sebagai base URL, contoh:

```text
https://xxxx.ngrok-free.app/shopee?storeId=178926468&dealId=21448123549
```

## Metode & Eksperimen yang Dicoba

Selama pengembangan, endpoint contoh (`storeId=178926468&dealId=21448123549` dan `storeId=3543467&dealId=18904813090`) mengalami rate/anti-bot yang persisten setelah volume testing berulang. Tabel berikut mendokumentasikan setiap pendekatan yang dicoba untuk mengatasinya, agar penguji punya gambaran lengkap proses debugging dan trade-off tiap metode — **bukan** cuma solusi akhir yang jalan.

| # | Metode | Cara mengaktifkan | Hasil | Catatan |
|---|--------|--------------------|-------|---------|
| 1 | Playwright standar + stealth plugin | (awal, sebelum migrasi ke rebrowser) | ❌ Terdeteksi sejak request pertama (`error: 90309999`) | Diduga leak CDP `Runtime.enable` |
| 2 | `rebrowser-playwright` + stealth (default saat ini) | Default | ✅ Berhasil 1x di awal (request tunggal) — ❌ gagal konsisten setelah volume tinggi | Base arsitektur yang dipakai |
| 3 | Sesi per-item (bukan global) | Default | ✅ Memperbaiki bug sesi ke-share lintas produk berbeda | Bug nyata, sudah diperbaiki permanen |
| 4 | Resource blocking (skip image/font/css) | `BLOCK_STATIC_ASSETS=true` | ⚠️ Belum dites terisolasi — berpotensi jadi sinyal deteksi baru | Default: mati |
| 5 | Proxy datacenter gratis (Webshare, publik) | `PROXY_LIST` | ❌ Sebagian besar mati/timeout | Kualitas proxy gratis tidak reliable |
| 6 | Proxy residential + geo-Taiwan (DataImpulse) | `PROXY_LIST` + `PROXY_MODE=sticky` | ❌ Tetap kena `90309999`, bahkan dari IP TW asli & `curl` polos | Membuktikan ini bukan soal IP/reputasi semata |
| 7 | Navigasi bertahap (warm-up: homepage dulu, delay, baru ke produk) | `NAVIGATION_STRATEGY=warmup` | ❌ Tetap kena `90309999` di request pertama | Pola navigasi organik saja tidak cukup |
| 8 | Chrome asli terinstal (bukan Chrome-for-Testing bawaan) | `CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/...` | ❌ Gagal — bukan soal anti-bot, tapi crash internal (`session closed`) | Patch CDP `rebrowser-playwright` tidak kompatibel dengan versi protokol Chrome stable; hanya cocok dengan revisi Chrome-for-Testing yang dibundel |
| 9 | Persistent browser profile (cookies bertahan antar bootstrap) | `PERSISTENT_PROFILE=true` | ❌ Gagal karena bug library — bukan soal anti-bot | `playwright-extra`'s `launchPersistentContext` mengabaikan opsi `executablePath` custom, jatuh ke path default lama yang tidak ada di sistem. Kode fitur ini tetap ada di `session.manager.ts` untuk referensi, tapi tidak bisa dites tuntas karena bug ini |

**Kesimpulan sementara (sudah dikoreksi, lihat catatan di bawah):** kombinasi bukti (curl polos tanpa fingerprint dapat kode sama; IP Taiwan asli tetap gagal; homepage SPA memuat modul `pcmall-anticrawler` eksplisit) mengindikasikan Shopee TW punya sistem anti-scraping matang yang menilai risiko berdasarkan kombinasi banyak sinyal — tapi **penting dicatat**: sebagian besar eksperimen di atas mengubah **lebih dari satu variabel sekaligus** (mis. metode #6 mengganti proxy sekaligus jaringan bersamaan), sehingga kesimpulan seperti "IP tidak berpengaruh" belum benar-benar teruji secara ketat dengan isolasi variabel tunggal. Lihat bagian berikutnya untuk analisis lanjutan yang mengoreksi hal ini.

## Analisis Eksternal & Perbaikan Lanjutan

Dua analisis independen direview terhadap temuan di atas, masing-masing mengambil sudut pandang berbeda dan saling melengkapi:

**Analisis 1 — hipotesis spesifik (TLS/HTTP2 fingerprint mismatch):** begitu Playwright (fingerprint TLS Chromium) menerbitkan cookie/sesi, request axios berikutnya (fingerprint TLS Node.js/OpenSSL) bisa dianggap "session hijacking" oleh Shopee karena fingerprint transport-nya berubah di tengah sesi. **Catatan validitas:** hipotesis ini tidak sepenuhnya cocok dengan data kita — di beberapa log, kode `90309999` muncul **langsung dari capture response browser native saat bootstrap**, bukan cuma dari replay axios — jadi TLS mismatch kemungkinan salah satu kontributor, bukan satu-satunya penyebab.

**Analisis 2 — kritik metodologis:** menyoroti bahwa banyak eksperimen kita mengubah >1 variabel sekaligus (melemahkan kekuatan kesimpulan), dan yang lebih penting — **pola retry kita sendiri (`refresh session → retry → refresh lagi → retry lagi`) diduga memperparah risk/velocity score**, bukan menyelesaikannya. Juga menyoroti load test awal (`20 request, concurrency 4`, langsung tanpa ramp-up bertahap) sebagai kemungkinan pemicu langsung item contoh ter-flag.

### Perbaikan yang diimplementasikan dari kedua analisis ini

| Sumber | Rekomendasi | Implementasi |
|---|---|---|
| Analisis 1 | In-browser fetch via `page.evaluate()` | `IN_BROWSER_FETCH=true` (kini default) — lihat poin #11 di Teknik Anti-Deteksi |
| Analisis 2 | Klasifikasi error granular, bukan satu error generik | `src/lib/errors.ts` — 9 tipe error dengan kebijakan retry masing-masing |
| Analisis 2 | `TRAFFIC_VERIFICATION` jangan di-retry agresif | `retry.ts` — `maxRetries: 0` untuk tipe ini, langsung fail + cooldown |
| Analisis 2 | Circuit breaker per produk/sesi | `session.manager.ts` — status `blocked` + `BLOCKED_COOLDOWN_MS` |
| Analisis 2 | Sticky proxy harus konsisten sepanjang sesi (bukan per-request) | Bug nyata ditemukan & diperbaiki — lihat poin #10 di Teknik Anti-Deteksi |
| Analisis 2 | Load test naik bertahap (1→5→10→...→200), bukan langsung volume tinggi | `test/loadtest.ts` — mode `RAMP_UP=true` |
| Analisis 2 | Observability: `requestId`, `sessionAgeMs`, `latencyMs`, `responseHasItem`, dll | Ditambahkan ke log `shopee.client.ts` |

### Rekomendasi yang belum/tidak diimplementasikan (dan alasannya)

- **`tls-client` (TLS impersonation via native binary Go)**. Tidak diimplementasikan karena `IN_BROWSER_FETCH` mencapai tujuan yang sama (eliminasi mismatch TLS) tanpa dependency native tambahan yang menambah kompleksitas deployment secara signifikan.
- **Eksperimen isolasi variabel tunggal penuh** (matriks hipotesis: replay request, lifetime signature, binding per-produk, device vs IP, perbandingan endpoint) — daftar eksperimen ini sangat berharga tapi masing-masing butuh produk yang benar-benar baru + akses live ke Shopee untuk dijalankan dengan benar (sesuatu yang sudah sangat terbatas di sesi ini karena volume testing sebelumnya). Kerangka kerja retry/error/circuit-breaker baru di atas sudah dirancang supaya eksperimen-eksperimen ini **bisa** dijalankan dengan lebih aman (tidak memperparah risk score) kapan pun akses ke produk baru tersedia.

### Catatan tambahan: riset publik tentang mekanisme signature Shopee

Untuk memvalidasi arah `IN_BROWSER_FETCH`, ditelusuri juga dokumentasi teknis publik yang membahas struktur header anti-fraud Shopee (`af-ac-enc-sz-token` sebagai konstanta level-sesi, `x-sap-ri` sebagai signature per-request). Temuan yang relevan untuk desain kita:

- Signature per-request dilaporkan terikat ke **sequence counter di sisi device**, bukan murni time-based — permintaan yang "out-of-sequence" ditolak meski signature-nya sendiri valid. Ini konsisten dengan pola berulang yang kita amati sendiri: navigasi pertama (dieksekusi langsung oleh browser) cenderung berhasil, sementara replay request berikutnya di luar browser (axios, walau memakai header hasil capture asli) yang mulai gagal.
- Signature ini dihasilkan oleh logic yang di-obfuscate berat di sisi client (bukan formula statis yang bisa direplikasi dengan HMAC biasa) — mengonfirmasi bahwa pendekatan kita (menangkap sesi dari browser asli, bukan mencoba merekonstruksi algoritma signature secara statis) adalah arah yang tepat, bukan jalan pintas yang harusnya dihindari.
- Implikasi langsung ke desain: karena replay di luar browser secara struktural rawan gagal begitu counter desync, `IN_BROWSER_FETCH` diubah dari opsional menjadi **default aktif** (lihat poin #11 di atas) — setiap panggilan `get_pc`/`get_rw` dieksekusi oleh instance browser yang sama yang memegang sesi, bukan direplay lewat client terpisah.

## Batasan yang Diketahui

- Signature/header yang ditangkap dari satu navigasi produk (`bootstrap`) mungkin bersifat spesifik untuk produk tersebut. Jika Shopee mengikat signature ke `item_id`/`shop_id` tertentu, request untuk produk lain di luar sesi bootstrap bisa memicu error terklasifikasi (`INVALID_RESPONSE`, lihat `src/lib/errors.ts`) — namun ini otomatis ditangani: `retry.ts` akan memicu `session.manager.refresh()` **dengan storeId/dealId yang sedang diminta**, sehingga sistem secara efektif melakukan bootstrap browser baru khusus untuk produk tersebut sebelum retry, lalu meng-cache-nya untuk request berikutnya ke produk yang sama.
- Proxy tidak disediakan oleh pihak penguji (sesuai ketentuan tugas) — pengguna API ini bertanggung jawab menyediakan proxy sendiri via `PROXY_LIST` bila diperlukan.

### Catatan: Shopee traffic verification wall (`/verify/traffic/error`)

Selama pengembangan, ditemukan bahwa Shopee TW punya lapisan anti-bot yang me-redirect traffic yang dicurigai ke halaman `shopee.tw/verify/traffic/error?...&is_logged_in=false` — tampilannya menyerupai "silakan login" biasa, tapi path URL-nya mengonfirmasi ini fallback sistem risk-control, bukan requirement login yang genuine.

Temuan penting dari eksperimen: wall ini muncul **konsisten pada device yang sama meski IP/jaringan sudah diganti total** (SIM card berbeda, dengan/tanpa VPN), tapi request pertama yang dilakukan sebelum volume testing tinggi berhasil mengembalikan data asli lengkap — mengindikasikan ini kombinasi **rate/velocity-based risk scoring per device+network** yang terakumulasi dari volume testing berulang dalam waktu singkat, bukan kegagalan struktural pada scraper. `session.manager.ts` sekarang mendeteksi redirect ke `/verify/traffic` secara eksplisit dan langsung memicu error `TRAFFIC_VERIFICATION` (gagal cepat + cooldown, **tanpa** retry otomatis — lihat bagian Analisis Eksternal & Perbaikan Lanjutan) alih-alih menunggu timeout penuh.

Implikasi praktis: untuk volume testing sungguhan (200+ item, durasi lama), **proxy rotation sungguh-sungguh diperlukan** (bukan opsional) agar tidak ada satu IP yang mengakumulasi cukup banyak request untuk memicu wall ini — sesuai desain `proxy.manager.ts` yang sudah pluggable untuk kebutuhan ini.

**Update — pengujian dengan IP bersih + browser hardened penuh:** untuk menguji ulang hipotesis rate/velocity-based di atas dengan lebih ketat, dilakukan eksperimen tambahan: browsing manual (bukan lewat API) ke `shopee.tw` menggunakan kombinasi **proxy residential berbayar (DataImpulse) dengan geo-targeting Taiwan** — bukan proxy gratis/publik — untuk memastikan IP yang baru & terverifikasi bersih (geo-targeted via suffix `__cr.tw` pada kredensial proxy, bukan IP yang sudah dipakai testing sebelumnya) **dan** browser hasil stack anti-deteksi proyek ini sendiri (`rebrowser-playwright` + stealth, lihat `scripts/browse.ts`) — bukan Chrome biasa tanpa mitigasi apa pun.

Hasilnya: wall verifikasi/login tetap muncul, **bukan hanya untuk 2 item contoh yang sudah ter-flag, tapi untuk navigasi umum ke `shopee.tw` sekalipun** (sebelum sempat mengklik produk apa pun). Ini titik data penting yang mempersempit hipotesis:

- Bukan murni soal reputasi IP/jaringan — IP residential Taiwan yang dipakai baru pertama kali dan tervalidasi geo-correct.
- Bukan murni soal fingerprint browser — browser yang dipakai sudah melalui seluruh mitigasi CDP-leak dan stealth yang didokumentasikan di atas.
- Blok terjadi pada level navigasi awal (homepage), bukan spesifik pada 2 item lama atau pada panggilan API `get_pc`/`get_rw`.

Kesimpulan yang lebih kuat: kemungkinan besar Shopee TW saat ini menerapkan **risk-scoring gabungan di banyak layer sekaligus** (device/browser signal, jaringan, dan kemungkinan juga histori akun/sesi browser lokal) yang tidak sepenuhnya bisa diatasi hanya dari sisi client — walau begitu, desain sistem (circuit breaker, klasifikasi error `TRAFFIC_VERIFICATION`, retry policy konservatif, dan opsi teknik yang bisa dikombinasikan di `src/techniques/`) tetap relevan sebagai mitigasi produksi, karena wall ini pada dasarnya adalah salah satu mode kegagalan yang harus ditangani dengan graceful, bukan dihindari 100%.

**Update — replikasi di region Shopee lain (shopee.co.id), isolasi variabel stealth tooling.** Untuk menguji apakah blok ini spesifik ke domain `.tw` atau ke fingerprint tooling kita, dicoba navigasi ke `shopee.co.id` (region berbeda, platform sama) dari jaringan yang **bisa** konek langsung tanpa hambatan DNS/SNI (lihat catatan DNS hijacking di bawah), dengan browser + sesi benar-benar baru (tanpa histori apa pun):

- Endpoint personalisasi homepage (`recommend/recommend`, `flash_sale/flash_sale_get_items`) mengembalikan **`error: 90309999` yang identik** dengan yang selalu ditemui di `shopee.tw` — pada navigasi pertama, tanpa histori, tanpa proxy.
- Diuji ulang dengan `BROWSER_ENGINE=vanilla` (Playwright polos, **tanpa** `rebrowser-playwright` maupun stealth plugin sama sekali) — hasilnya **identik**, `error: 90309999` tetap muncul.

Implikasi: ini mengeliminasi hipotesis bahwa tooling stealth kita (`rebrowser-playwright` + `puppeteer-extra-plugin-stealth`) yang dikenali/di-fingerprint secara spesifik — errornya sama persis walau tooling anti-deteksi itu dilepas total.

**Konfirmasi lanjutan: wall ini menggerbang seluruh akses, bukan cuma endpoint personalisasi.** Percobaan susulan dengan navigasi ke halaman kategori (bukan homepage) pada sesi guest baru yang sama menghasilkan redirect langsung ke halaman penuh **"Masuk Diperlukan"** (`Log In` / `Kembali ke Halaman Utama`) — pola yang identik dengan yang ditemui di `shopee.tw` sebelumnya (lihat catatan di atas). Ini kali ketiga pola yang sama teramati secara independen (homepage personalisasi di `.co.id`, halaman kategori di `.co.id`, dan wall di `.tw`), memperkuat kesimpulan: dari sesi guest yang benar-benar baru (tanpa histori, tanpa login, tanpa cookie lama), Shopee saat ini tampaknya menggerbang **hampir seluruh permukaan browsing** — bukan cuma fitur personal — di balik login, terlepas dari region maupun tooling browser yang dipakai (termasuk tanpa stealth sama sekali).

Ini bukan lagi murni pertanyaan "bagaimana menghindari deteksi bot", melainkan indikasi bahwa **akses guest/anonim ke Shopee saat ini sangat dibatasi secara umum** — sebuah keputusan produk/kebijakan yang levelnya di atas apa pun yang bisa diatasi lewat teknik anti-deteksi di sisi client.

**Konfirmasi final — diuji langsung ke `get_pc` pada produk nyata:** menggunakan `shopId`/`itemId` produk `shopee.co.id` yang valid dan baru (`50248646` / `18482027840`, produk ini ditemukan oleh penguji lewat akun **yang sudah login** — lihat catatan penting di bawah), navigasi langsung ke halaman produk tersebut dari sesi **guest** yang benar-benar baru (browser baru milik scraper, tanpa proxy, koneksi langsung, tanpa login) tetap menghasilkan **`get_pc` mengembalikan `error: 90309999`** — response HTTP-nya sendiri `200 OK`, tapi payload JSON-nya berisi kode error yang sama, bukan data produk. Ini pola yang identik dengan endpoint personalisasi dan wall login di `.tw`, kini terkonfirmasi langsung pada endpoint target tugas ini (`get_pc`).

**Catatan penting — produk uji ini ditemukan lewat akun yang sudah login.** Penguji melaporkan bahwa untuk sekadar *browsing* dan menemukan produk di atas, akun Shopee pribadinya harus dalam keadaan login — mengonfirmasi dari sisi manusia (bukan cuma otomasi) bahwa **guest browsing memang sedang dibatasi Shopee secara luas saat ini**, bukan sesuatu yang spesifik terjadi pada scraper/browser otomatis kita. Ini bukti pelengkap yang independen dari semua temuan otomasi di atas, dan memperkuat kesimpulan bahwa akar masalahnya adalah kebijakan akses guest, bukan deteksi bot yang bisa diatasi teknik client-side.

Sesuai cakupan tugas ini (scraping publik tanpa akun/kredensial pribadi, konsisten dengan asumsi awal desain), scraper **tetap dijalankan dalam mode guest/anonim** — tidak diarahkan untuk memakai sesi akun pribadi yang sudah login, baik karena itu di luar cakupan awal tugas maupun karena risiko akun asli terkena flag/banned akibat volume otomasi (200+ request). Pembatasan akses guest ini didokumentasikan di sini sebagai **batasan eksternal dari sisi Shopee saat pengujian dilakukan**, bukan kegagalan desain scraper — arsitektur (session capture dari browser asli, retry/circuit-breaker per klasifikasi error, dsb.) tetap merupakan pendekatan yang benar untuk skenario guest-scraping begitu kebijakan akses Shopee kembali lebih longgar, atau saat dijalankan dari kondisi jaringan/akun yang belum ter-throttle.

**Update — pengujian dengan sesi login sungguhan (fitur `AUTH_MODE=login`), mengoreksi kesimpulan di atas.** Untuk mengisolasi variabel login-vs-guest secara langsung (bukan cuma dugaan), dibangun mode `AUTH_MODE=login` (lihat [Mode Guest vs Login](#mode-guest-vs-login-auth_mode)) yang memuat *storage state* hasil login manual sungguhan (akun asli, lewat `npm run login`, OTP/captcha diisi manusia langsung). Diuji terhadap produk `shopee.co.id` yang sama (`shopId=50248646`, `itemId=18482027840`) yang sebelumnya ditemukan penguji lewat akun ber-login itu sendiri.

Hasilnya: **`get_pc` tetap mengembalikan `error: 90309999`, identik dengan mode guest** — walau browser bootstrap membawa cookies sesi login asli yang valid. Ini mengoreksi kesimpulan sebelumnya: **status login/guest ternyata bukan faktor pembeda.** Karena penguji sendiri (manusia, browser biasa, bukan otomasi) berhasil browsing dan menemukan produk yang sama dengan akun yang sama, sementara sesi login yang identik gagal ketika diakses lewat browser otomasi kita (Playwright/CDP, walau dengan `rebrowser-playwright` + stealth) — pembedanya kemungkinan besar kembali ke **deteksi otomasi/CDP itu sendiri**, bukan kebijakan akses guest seperti dugaan sebelumnya. Ini konsisten dengan hasil awal proyek ini (satu-satunya keberhasilan penuh terjadi di request pertama sebelum volume testing tinggi) dan memperkuat bahwa akar masalahnya berada pada tingkat deteksi automation-browser yang lebih dalam dari yang bisa diatasi kombinasi teknik anti-deteksi publik (`rebrowser-playwright`, stealth plugin, dst.) yang didokumentasikan di proyek ini.

**Isolasi lanjutan — binary Chrome asli via `channel: "chrome"` (bukan Chrome-for-Testing).** Untuk menyingkirkan hipotesis bahwa Chrome-for-Testing (binary yang dipakai `rebrowser-playwright` secara default) punya sinyal identitas tersendiri yang dikenali, ditambahkan dukungan `BROWSER_CHANNEL=chrome` (lihat `src/services/session.manager.ts`) yang membuat Playwright meluncurkan **Chrome stable asli yang benar-benar terinstal**, dikombinasikan dengan `BROWSER_ENGINE=vanilla-stealth` (menghindari ketidakcocokan patch CDP `rebrowser-playwright` dengan revisi protokol Chrome stable — lihat metode #8 di tabel eksperimen) dan sesi login yang sama.

Hasilnya, untuk ketiga kalinya secara independen: **`get_pc` tetap `error: 90309999`.** Sampai titik ini, tiga variabel besar sudah dieliminasi satu per satu — jaringan/IP (IP Taiwan residential bersih tetap gagal), tooling stealth (vanilla tanpa stealth sama sekali tetap gagal), status login (sesi login asli tetap gagal), dan kini binary browser (Chrome stable asli, bukan Chrome-for-Testing, tetap gagal). Satu-satunya pembeda yang tersisa antara pengujian otomatis ini dan keberhasilan browsing manual penguji adalah **kontrol CDP/Playwright itu sendiri** — Chrome yang dikendalikan lewat protokol automation (Chrome DevTools Protocol), betapa pun mirip binary dan sesinya dengan Chrome yang dipakai manual, versus Chrome yang benar-benar diklik langsung oleh manusia tanpa perantara automation apa pun.

**Percobaan isolasi paling ekstrem — CDP-attach ke profil Chrome default milik penguji — terhalang oleh Chrome sendiri.** Upaya terakhir untuk isolasi total (Playwright *connect* ke instance Chrome default yang sudah dibuka & login manual oleh penguji, bukan meluncurkan instance baru sama sekali) tidak bisa dijalankan: Chrome versi modern **menolak mengaktifkan remote debugging port pada profil default** (`--remote-debugging-port` di-set tapi port tidak benar-benar listen), sebagai hardening keamanan resmi Chrome untuk mencegah automation asing meng-CDP browser yang sudah login penuh milik pengguna — persis skenario yang ingin diuji di sini. Workaround-nya (profil Chrome terpisah + login manual ulang di profil itu) secara substansi setara dengan pengujian `AUTH_MODE=login` yang sudah dilakukan di atas, sehingga tidak akan memberi data baru. Ini sendiri sebuah temuan kecil yang menarik: Chrome secara aktif mempersulit skenario "CDP mengendalikan profil browser asli pengguna" — sejalan dengan arah kesimpulan bahwa kontrol CDP/automation adalah sinyal yang secara struktural sulit disamarkan sepenuhnya, di luar kendali teknik anti-deteksi apa pun di level aplikasi.

**Dua isolasi tambahan: headless vs headful, dan `patchright` (patch CDP paling menyeluruh yang tersedia publik).**

- **Headless vs headful (`HEADLESS=false`).** Seluruh pengujian `get_pc` sebelumnya lewat server (`session.manager.ts`) berjalan headless secara default — sementara `scripts/login.ts`/`scripts/browse.ts` yang berhasil browsing manual selalu headful. Ini variabel yang belum pernah dikontrol. Diuji `HEADLESS=false` (browser sungguh-sungguh terlihat, bukan cuma "new headless mode") dengan sesi login yang sama: hasilnya identik, tetap `error: 90309999` / wall `/verify/traffic`.
- **`patchright` — CDP patch paling menyeluruh yang tersedia publik per riset 2026.** `rebrowser-playwright` mem-patch leak `Runtime.enable` tertentu, tapi riset eksternal (lihat sitasi di bawah) menunjukkan ada kelas leak CDP lain yang lebih luas: serialisasi `Runtime.enable` lewat getter yang ter-observasi, leak `Console.enable`, dan flag command-line seperti `--enable-automation`. [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) (dipasang via `npm i patchright && npx patchright install chromium`, dipilih lewat `BROWSER_ENGINE=patchright`) menutup seluruh kelas leak itu — menghindari `Runtime.enable` sepenuhnya lewat isolated execution context, mem-patch `Console.enable`, dan menghapus `--enable-automation` dari argumen launch. Diuji dengan sesi login yang sama: **hasilnya tetap `error: 90309999`**, walau kali ini tanpa noise crash CDP yang biasa muncul dari `rebrowser-playwright` (patchright menangani protokol CDP lebih bersih secara teknis, tapi hasil deteksi anti-bot-nya identik).

**Ringkasan enam variabel independen yang sudah dieliminasi**, semuanya menghasilkan `error: 90309999` yang identik:

| # | Variabel | Cara isolasi | Hasil |
|---|---|---|---|
| 1 | Jaringan/IP | Proxy residential **berbayar** dengan geo-targeting Taiwan (DataImpulse, bersih & baru) | Tetap gagal |
| 2 | Tooling stealth | `BROWSER_ENGINE=vanilla` (tanpa mitigasi apa pun) | Tetap gagal |
| 3 | Status login | `AUTH_MODE=login` dengan sesi akun asli | Tetap gagal |
| 4 | Binary browser | `BROWSER_CHANNEL=chrome` (Chrome stable asli) | Tetap gagal |
| 5 | Headless vs headful | `HEADLESS=false` | Tetap gagal |
| 6 | Kedalaman patch CDP | `BROWSER_ENGINE=patchright` (patch paling menyeluruh yang tersedia publik) | Tetap gagal |

**Validasi eksternal independen (bukan cuma temuan proyek ini).** Riset publik per pertengahan 2026 mengonfirmasi pola yang sama persis di region Shopee lain:

> "There is no working unauthenticated path on Shopee Malaysia as of 2026-05-20. The v4 JSON API returns error: 90309999 ... Shopee's WAF accepts the cookies and knows the user is logged in; it's blocking on the missing [per-request] signature... the block is fingerprint-based, making it difficult to bypass through traditional proxy methods alone."

Kutipan ini secara independen mengonfirmasi: (a) kode error yang sama persis (`90309999`) muncul di region Shopee lain, bukan cuma `.tw`/`.co.id`; (b) tidak ada jalur unauthenticated yang berfungsi di seluruh platform Shopee saat ini menurut komunitas scraping eksternal; (c) bahkan sesi ber-cookie/login yang valid tetap diblokir berdasarkan fingerprint konteks eksekusi, bukan validitas cookie itu sendiri — persis dengan temuan `AUTH_MODE=login` di atas.

**Kesimpulan akhir.** Dengan enam variabel independen tereliminasi secara sistematis dan divalidasi oleh sumber eksternal yang tidak berhubungan dengan proyek ini, bukti mengarah kuat ke satu hal: Shopee saat ini menjalankan sistem anti-bot yang mengevaluasi **konteks eksekusi JavaScript itu sendiri** (kemungkinan lewat sinyal-sinyal di level protokol CDP yang bisa diobservasi dari sisi server — timing microtask, jejak eksekusi kode yang disuntikkan, atau sinyal CDP lain di luar cakupan `Runtime.enable`/`Console.enable`/command-flag yang sudah dipatch `patchright`) — bukan IP, bukan login, bukan browser binary, bukan mode headless. Ini konsisten dengan definisi "fingerprint-based blocking" yang disebut riset eksternal, dan berada di luar jangkauan kombinasi teknik anti-deteksi publik mana pun yang tersedia saat dokumentasi ini ditulis.

<sub>Sumber: [browse.sh — Shopee Malaysia Product Search](https://browse.sh/skills/shopee.com.my/search-products-5epzg0), [Foil — CDP detection in 2026](https://usefoil.com/learn/cdp-detection), [crawlex.net — Detecting CDP in the wild](https://blog.crawlex.net/blog/detecting-cdp-runtime-enable/), [DataDome — New Headless Chrome & the CDP Signal](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/), [patchright-nodejs](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs).</sub>

### Analisis lanjutan: menyingkirkan hipotesis signature-replay

Laporan investigasi di atas (bagian 6–8) juga diberikan ke dua asisten AI eksternal untuk second opinion. Kedua analisis sepakat menempatkan hipotesis "murni soal signature/proxy/stealth" di ranking confidence rendah — konsisten dengan tabel eliminasi 6-variabel di atas — tapi salah satu mengusulkan satu eksperimen penentu yang belum eksplisit kami jalankan sebagai eksperimen terpisah: **bandingkan request `get_pc` yang benar-benar dibuat oleh JS Shopee sendiri (native) vs `page.evaluate(fetch())` kita vs axios, untuk produk & sesi yang sama** — kalau ketiganya gagal identik, maka bukan soal replay/transport, tapi environment/browser-nya sendiri yang sudah ditolak sebelum request itu dikirim.

Ternyata **kita sudah punya jawabannya dari data yang ada**: `bootstrap()` di `session.manager.ts` meng-intercept request `get_pc` yang murni dibuat oleh JS Shopee sendiri (`page.on("request")` + `waitForResponse`, sebelum kode kita melakukan `page.evaluate` atau axios apa pun) — dan response native ini **sudah** berisi `error: 90309999` sejak awal. Artinya: native = in-browser-fetch = axios, ketiganya gagal identik. Ini menyingkirkan hipotesis signature-replay/transport-mismatch sebagai akar masalah — sejalan dengan tabel eliminasi 6-variabel, dan menegaskan lagi bahwa masalahnya ada di level environment/browser yang ditolak sebelum request apa pun sempat dikirim, bukan di kualitas replay header.

Catatan tambahan: salah satu analisis eksternal menduga blokir terjadi murni di level Edge/WAF (TCP/TLS handshake) sebelum JS sempat berjalan sama sekali. Ini kurang konsisten dengan bukti yang kami punya — response yang di-capture berstruktur JSON lengkap sesuai skema normal Shopee (`"0","1","2","3":90309999,...,"6":<blob>`), ciri khas response dari application layer Shopee sendiri, bukan halaman block generic dari edge/WAF (yang biasanya berupa HTML atau connection reset, bukan JSON terstruktur rapi).

**Dua sudut yang masih genuinely belum diuji** dari kedua analisis ini, untuk eksperimen lanjutan kalau ada waktu/akses produk baru:
1. **Rantai navigasi realistis penuh** (homepage → search → kategori → klik ke produk, bukan `page.goto()` langsung ke URL produk) dalam satu sesi persistent, dites lintas beberapa produk berurutan — berbeda dari teknik "warmup" kami saat ini yang cuma mampir ke homepage + delay acak sebelum tetap `goto()` langsung ke URL produk.
2. **Emulasi mobile device** (`isMobile: true`, viewport & user-agent mobile) dikombinasikan dengan `get_rw` (bukan `get_pc`) dan header `x-api-source: rn` — dugaannya trust-bias Shopee terhadap traffic mobile-web lebih tinggi dibanding desktop. Belum pernah dites sama sekali di proyek ini (selalu pakai viewport desktop 1366×768, `zh-TW`).

### Catatan: DNS hijacking di jaringan tertentu (mis. ISP Indonesia)

Saat pengembangan, ditemukan bahwa beberapa jaringan ISP (mis. Telkomsel/"internetbaik") melakukan **DNS hijacking** untuk domain `shopee.tw` — resolusi DNS dialihkan ke IP block-page milik ISP, bukan IP asli Shopee, sehingga baik akses langsung maupun lewat sebagian proxy (yang meresolusi hostname secara lokal, mis. SOCKS4 klasik) akan gagal total meski kode maupun proxy-nya sendiri berfungsi normal.

Cara mendeteksi masalah ini:

```bash
# Bandingkan hasil resolusi DNS lokal vs DNS-over-HTTPS pihak ketiga
nslookup shopee.tw
curl -s "https://cloudflare-dns.com/dns-query?name=shopee.tw&type=A" -H "accept: application/dns-json"
```

Jika kedua IP berbeda jauh (satu milik ISP lokal, satu milik infrastruktur Shopee/Cloudflare/Akamai), berarti jaringan Anda kena DNS hijack untuk domain ini.

**Update — pemblokiran juga terjadi di level SNI, bukan cuma DNS.** Bahkan saat IP asli Shopee dipaksa secara eksplisit (`curl --resolve shopee.tw:443:<IP-asli>`, melewati DNS hijack), koneksi TLS tetap gagal dengan `Connection reset by peer` tepat setelah `ClientHello` (pada titik SNI `shopee.tw` terkirim plaintext) — pola khas pemblokiran DPI (deep packet inspection) berbasis SNI oleh jaringan, di luar kendali aplikasi/kode. Praktisnya: pada jaringan yang kena kombinasi DNS hijack + SNI block ini, **koneksi langsung (tanpa proxy) ke `shopee.tw` mustahil berhasil sama sekali** — bukan soal deteksi anti-bot Shopee, tapi jaringan lokal itu sendiri yang memutus koneksi sebelum sempat sampai ke Shopee. Ini menjelaskan mengapa proxy (yang membuat koneksi TLS keluar dengan SNI ke domain proxy, bukan `shopee.tw`, dari luar jaringan yang diblokir) tetap jadi mitigasi yang diperlukan di jaringan seperti ini — bukan cuma untuk menghindari IP-reputation Shopee, tapi juga untuk melewati blokir jaringan lokal itu sendiri.

Workaround bila mengalami hal serupa: ganti DNS resolver sistem ke DNS pihak ketiga yang tidak dihijack (mis. `1.1.1.1`/`8.8.8.8` via DoH/DoT), atau gunakan proxy/VPN yang melakukan resolusi DNS **di sisi remote** (SOCKS5 dengan `--socks5-hostname`, bukan SOCKS4 klasik) sehingga resolusi tidak bergantung pada DNS lokal yang sudah dihijack.
