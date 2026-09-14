# Shopee Taiwan Scraper API

REST API (TypeScript) yang mengambil data detail produk dari Shopee Taiwan (`get_pc`/`get_rw`) dengan pendekatan **hybrid**: browser headless (Playwright + stealth) dipakai jarang untuk membangun sesi/cookie/header yang valid, sedangkan mayoritas request produk dilayani lewat HTTP client ringan (axios) yang menggunakan ulang sesi tersebut — menyeimbangkan ketahanan terhadap anti-bot dengan skalabilitas.

> **Status:** Kode lengkap, type-check/lint/build bersih, dan **terbukti berhasil sekali secara end-to-end** mengambil data produk asli lengkap sesuai skema `get_pc`. Setelah itu, dua item contoh yang dipakai berulang kali selama development memicu sistem anti-bot Shopee (`/verify/traffic/error`, kode `90309999`) yang terbukti persisten lintas IP/jaringan/proxy (lihat [Metode & Eksperimen yang Dicoba](#metode--eksperimen-yang-dicoba) — 9 pendekatan berbeda didokumentasikan dengan hasilnya). Arsitektur sudah mengimplementasikan praktik standar untuk high-quality scraping (session management, retry-aware anti-bot detection, proxy pluggable sticky/rotating, resource optimization); uji volume 200+ item yang konsisten kemungkinan besar butuh item/produk yang belum pernah "dibakar" testing berulang dan/atau proxy residential premium.

## Daftar Isi

- [Arsitektur](#arsitektur)
- [Setup & Menjalankan Lokal](#setup--menjalankan-lokal)
- [Konfigurasi Proxy](#konfigurasi-proxy)
- [Penggunaan API](#penggunaan-api)
- [Teknik Anti-Deteksi](#teknik-anti-deteksi)
- [Load Test / Uji Stabilitas](#load-test--uji-stabilitas)
- [Hosting via Ngrok](#hosting-via-ngrok)
- [Metode & Eksperimen yang Dicoba](#metode--eksperimen-yang-dicoba)
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
    retry.ts               Retry dgn backoff, beda perlakuan network error vs anti-bot
    logger.ts              Structured logging (pino)
  middleware/
    validateQuery.ts
    errorHandler.ts
  types/shopee.ts          Tipe ShopeeSession, ShopeeProductParams
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

1. **Sesi & header dari browser asli, bukan ditiru manual.** `session.manager.ts` membuka halaman produk lewat Playwright (dengan `puppeteer-extra-plugin-stealth`, yang menutupi indikator umum automation seperti `navigator.webdriver`, inkonsistensi plugin/permissions, dsb) dan menyadap (`page.on("request")`) header **yang benar-benar dikirim browser** ke endpoint `get_pc`/`get_rw`, termasuk signature dinamis Shopee (mis. `af-ac-enc-dat`, `x-api-source`) yang sulit dipalsukan manual. Ini menghindari kebutuhan reverse-engineer algoritma signature Shopee secara statis, yang rawan basi ketika Shopee mengubah implementasinya.
2. **`rebrowser-playwright` alih-alih Playwright standar.** Playwright biasa (bahkan dengan stealth plugin) tetap meninggalkan jejak yang bisa dideteksi lewat cara ia memakai Chrome DevTools Protocol (mis. leak dari `Runtime.enable`) — vektor deteksi yang sudah dikenal luas dan tidak ditutupi stealth plugin generik. `rebrowser-playwright` adalah fork Playwright yang di-patch khusus untuk menghilangkan jejak CDP tersebut.
3. **Penanganan interstitial pemilihan bahasa.** Navigasi pertama ke `shopee.tw` bisa menampilkan popup pilih bahasa/wilayah untuk visitor baru, yang kalau tidak ditangani akan memblokir halaman produk asli (dan `get_pc`) untuk pernah dimuat. Kode menyuntik cookie preferensi bahasa lebih dulu, dan sebagai fallback mencoba klik opsi Bahasa Mandarin Tradisional/Taiwan bila popup tetap muncul.
4. **Reuse sesi per-produk, bukan browser-per-request.** Sesi (cookie + header) di-cache **per `storeId`+`dealId`** dengan TTL (`SESSION_REFRESH_INTERVAL_MS`, default 10 menit) dan dipakai ulang untuk request berikutnya ke produk yang sama lewat HTTP client ringan (axios). Pengujian menunjukkan sesi Shopee terikat erat ke halaman produk yang dinavigasi (kemungkinan lewat referer/token yang tervalidasi silang), sehingga sesi **tidak** di-share lintas produk berbeda — tiap produk baru tetap butuh satu navigasi Playwright untuk bootstrap sesi, tapi request berulang ke produk yang sama dalam TTL tetap ringan lewat axios.
5. **Rate limiting alami.** `rateLimiter.ts` membatasi concurrency (default 4 request paralel) dan menambahkan jeda acak (jitter, default 300–1500ms) antar request, agar pola waktu request tidak terlihat mekanis seperti bot flood.
6. **Retry yang membedakan jenis kegagalan.** `retry.ts` memisahkan penanganan network error/timeout (retry langsung dengan backoff eksponensial) dari sinyal anti-bot (403/429 → dianggap `AntiBotError`, memicu refresh sesi via browser dulu sebelum retry, karena retry dengan sesi basi hanya akan gagal lagi).
7. **Proxy rotation (opsional, pluggable).** `proxy.manager.ts` mendukung daftar proxy yang dirotasi round-robin, dengan proxy yang sering gagal otomatis dikarantina sementara — mengurangi ketergantungan pada satu IP keluar.
8. **Fallback endpoint.** Jika `get_pc` tidak mengembalikan item (null/error), otomatis dicoba `get_rw` sebagai cadangan.
9. **Resource blocking di Playwright (opsional, `BLOCK_STATIC_ASSETS=true`).** Karena hanya butuh JSON `get_pc`/`get_rw`, gambar/font/stylesheet bisa diblokir saat bootstrap untuk memangkas bandwidth ~60-80% (berguna untuk biaya proxy per-GB). **Default: mati** — elemen `<img>`/font yang tidak pernah selesai load bisa jadi sinyal deteksi tersendiri bagi JS anti-bot Shopee (browser manusia asli selalu menyelesaikan load-nya), jadi hanya aktifkan setelah kualitas IP/proxy sudah terbukti cukup baik dengan sendirinya.

## Load Test / Uji Stabilitas

Untuk memenuhi kriteria 200+ item dengan error rate <10% dan stabil selama uji berkelanjutan:

```bash
# Jalankan server di terminal terpisah: npm run dev

# Uji 200 request (default), concurrency 4
npm run loadtest

# Uji berbasis durasi (mis. 60 menit) alih-alih jumlah tetap
DURATION_MINUTES=60 npm run loadtest

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

**Kesimpulan sementara:** kombinasi bukti (curl polos tanpa fingerprint dapat kode sama; IP Taiwan asli tetap gagal; homepage SPA memuat modul `pcmall-anticrawler` eksplisit) mengindikasikan Shopee TW punya sistem anti-scraping matang yang menilai risiko berdasarkan kombinasi banyak sinyal (velocity, device, network reputation) — bukan celah tunggal yang bisa ditembus satu teknik saja. Arsitektur di repo ini (hybrid Playwright+axios, session per-item, retry dengan refresh, proxy pluggable, deteksi wall eksplisit) sudah mengimplementasikan praktik-praktik standar untuk high-quality scraping; keberhasilan konsisten pada volume tinggi kemungkinan besar butuh proxy residential premium dengan reputasi IP yang benar-benar bersih per-request (bukan shared pool), yang berada di luar anggaran budget testing sesi ini.

## Batasan yang Diketahui

- Signature/header yang ditangkap dari satu navigasi produk (`bootstrap`) mungkin bersifat spesifik untuk produk tersebut. Jika Shopee mengikat signature ke `item_id`/`shop_id` tertentu, request untuk produk lain di luar sesi bootstrap bisa memicu `AntiBotError` — namun ini otomatis ditangani: `retry.ts` akan memicu `session.manager.refresh()` **dengan storeId/dealId yang sedang diminta**, sehingga sistem secara efektif melakukan bootstrap browser baru khusus untuk produk tersebut sebelum retry, lalu meng-cache-nya untuk request berikutnya ke produk yang sama.
- Proxy tidak disediakan oleh pihak penguji (sesuai ketentuan tugas) — pengguna API ini bertanggung jawab menyediakan proxy sendiri via `PROXY_LIST` bila diperlukan.

### Catatan: Shopee traffic verification wall (`/verify/traffic/error`)

Selama pengembangan, ditemukan bahwa Shopee TW punya lapisan anti-bot yang me-redirect traffic yang dicurigai ke halaman `shopee.tw/verify/traffic/error?...&is_logged_in=false` — tampilannya menyerupai "silakan login" biasa, tapi path URL-nya mengonfirmasi ini fallback sistem risk-control, bukan requirement login yang genuine.

Temuan penting dari eksperimen: wall ini muncul **konsisten pada device yang sama meski IP/jaringan sudah diganti total** (SIM card berbeda, dengan/tanpa VPN), tapi request pertama yang dilakukan sebelum volume testing tinggi berhasil mengembalikan data asli lengkap — mengindikasikan ini kombinasi **rate/velocity-based risk scoring per device+network** yang terakumulasi dari volume testing berulang dalam waktu singkat, bukan kegagalan struktural pada scraper. `session.manager.ts` sekarang mendeteksi redirect ke `/verify/traffic` secara eksplisit dan langsung memicu `AntiBotError` (refresh sesi + retry) alih-alih menunggu timeout penuh.

Implikasi praktis: untuk volume testing sungguhan (200+ item, durasi lama), **proxy rotation sungguh-sungguh diperlukan** (bukan opsional) agar tidak ada satu IP yang mengakumulasi cukup banyak request untuk memicu wall ini — sesuai desain `proxy.manager.ts` yang sudah pluggable untuk kebutuhan ini.

### Catatan: DNS hijacking di jaringan tertentu (mis. ISP Indonesia)

Saat pengembangan, ditemukan bahwa beberapa jaringan ISP (mis. Telkomsel/"internetbaik") melakukan **DNS hijacking** untuk domain `shopee.tw` — resolusi DNS dialihkan ke IP block-page milik ISP, bukan IP asli Shopee, sehingga baik akses langsung maupun lewat sebagian proxy (yang meresolusi hostname secara lokal, mis. SOCKS4 klasik) akan gagal total meski kode maupun proxy-nya sendiri berfungsi normal.

Cara mendeteksi masalah ini:

```bash
# Bandingkan hasil resolusi DNS lokal vs DNS-over-HTTPS pihak ketiga
nslookup shopee.tw
curl -s "https://cloudflare-dns.com/dns-query?name=shopee.tw&type=A" -H "accept: application/dns-json"
```

Jika kedua IP berbeda jauh (satu milik ISP lokal, satu milik infrastruktur Shopee/Cloudflare/Akamai), berarti jaringan Anda kena DNS hijack untuk domain ini.

Workaround bila mengalami hal serupa: ganti DNS resolver sistem ke DNS pihak ketiga yang tidak dihijack (mis. `1.1.1.1`/`8.8.8.8` via DoH/DoT), atau gunakan proxy/VPN yang melakukan resolusi DNS **di sisi remote** (SOCKS5 dengan `--socks5-hostname`, bukan SOCKS4 klasik) sehingga resolusi tidak bergantung pada DNS lokal yang sudah dihijack.
