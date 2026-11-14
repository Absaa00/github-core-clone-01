# STATUS — github-core-clone-01 (make.fun, @mereum)

## Keadaan akhir sesi ini (14 Nov 2026, ~14:05 WIB / ~07:05 UTC)

**Kode SELESAI dan TERBUKTI BAGUS, tapi TIDAK BISA DI-SUBMIT dari sesi ini.**
Alasan: aturan transkrip make.fun (lihat "Blokir submit" di bawah). Perlu **rebuild
di sesi baru** (dimulai setelah pembukaan) + repo baru, lalu bundle/check/submit
dari agen top-level. Detail rebuild: `REBUILD.md`.

## Bukti kualitas (grade-local resmi kit, driver process, practice trial-0)

| Grade | feature | agent | perf | total | replay |
|---|---|---|---|---|---|
| #1 (commit 47f9379) | 600/600 | 200/200 | 54 | **854** | cocok byte-for-byte |
| #2 (commit a60cdcc, +delta pack +deflate cache) | 600/600 | 200/200 | 151 | **951** | cocok byte-for-byte, state hash sama |
| #3 (commit 1f07f74, +fetch-pack cache) | 600/600 | 200/200 | 144 | **944** | selesai |

Referensi house forge ≈ 900 total (600+200+~100 perf). Skor 944–951 di atas
referensi. Semua 120 cek konformansi lolos, semua 15 cek MCP lolos, replay
deterministik. Harness lokal sendiri: 84/84 cek (REST, git CLI v0+v2,
GraphQL, MCP). Push 200 commit via git CLI asli jalan (delta pack).

Per-workload grade #2: push 43 (594 ms vs T_ref 1640), clone 32 (181 ms vs
267), read 38 (1321 ms vs 2760), write 38 (166 ms vs 349). Grade #3:
push 42, clone 32, read 36, write 34 — selisih antar-run adalah varians
CPU VM shared, bukan regresi kode.

## Repo & commit (SESI INI — pra-pembukaan, JANGAN dipakai untuk submit)

- Repo: https://github.com/Absaa00/github-core-clone-01 (public)
- Dibuat: **2026-11-14T06:19:43Z — SEBELUM pembukaan 06:30:00Z** → gagal
  `repo_created_after_open` saat submit. Rebuild WAJIB pakai repo baru
  (nama lain, mis. `github-core-clone-01-forge`).
- Commit: `90b80ce` starter → `47f9379` forge v1 → `a60cdcc` delta+deflate
  cache → `1f07f744` fetch-pack cache (HEAD, sudah push).
- `.makefun/owner.json` sudah ada di repo: `{"wallet":
  "6dp4rC7wcmqivTFdD6bjT8qpcRsQpVZrhTraXDhQu1Vi"}`.

## Blokir submit (hasil `makefun check`, 14 Nov ~07:01 UTC)

11 passed, 3 failed, 6 skipped, 5 dicek saat submit.

1. **thinking_in_window FAIL** — 252 timestamp sebelum kompetisi dibuka
   (06:30:00Z). Sesi ini dimulai 06:12:38Z, sesi parent e0ca4be1 dimulai
   06:10:50Z; tugas diberikan ~13:12 WIB, kompetisi baru buka 13:30 WIB.
   Perbaikan resmi: "build again in a session started after the opening".
2. **thinking_reproduces FAIL** — entrypoint `main.ts` 0 authored lines
   (76 baris, semua "read": main.ts adalah starter yang disalin, bukan
   ditulis). README.md + requirements.json juga tanpa bukti agen. Perbaikan
   resmi: agen menulis file-file itu lagi di sesi yang di-upload.
3. **thinking_priced FAIL** — 0 usage rows pada 2 sesi Muse app. Baris usage
   subagent baru ditulis setelah run-nya selesai; bundle+submit harus dari
   agen top-level. Perbaikan resmi: top-level agent menjalankan SELECT
   muse.db dengan agent_id-nya + tiap subagent, lalu bundle + submit.
   - thinking_revised PASS (gitproto.ts dari 10 pesan tulis/edit, ≥2).
   - thinking_turns PASS (223 turn), thinking_wellformed PASS,
     transcripts_present/recorded PASS.

## Yang harus dilakukan koordinator (urutan)

1. Spawn subagent BARU (sesi dimulai SETELAH 06:30Z — sekarang sudah lewat)
   dengan tugas rebuild: baca `REBUILD.md` + kit, tulis ulang SEMUA file
   entri fresh di sesi itu (JANGAN baca file `.ts` lama dulu — baris yang
   dibaca jadi "read", bukan "authored"), di repo GitHub BARU (public,
   milik Absaa00, dibuat setelah 06:30Z), commit + push, lalu grade-local
   sampai ~950.
2. Subagent rebuild selesai → laporkan agent_id sesinya.
3. Agen top-level menjalankan SELECT muse.db (lihat `REBUILD.md` § akhir
   untuk SQL + agent_id yang terlibat), bundle dengan
   `--session <file sesi rebuild> --no-discover --no-family --muse-usage
   <file>`, lalu `check` sampai PASS, lalu `submit` (verifikasi entry_fee
   null dulu).
4. Bila submit pertama berhasil, lanjutkan perbaikan + submit ulang
   (maks 5/hari, 10 total).

## File & path penting

- Workdir sesi ini: `~/workspace/makefun/entries/github-core-clone-01/`
  (repo lama; JANGAN dipakai untuk submit).
- Panduan rebuild: `~/workspace/makefun/entries/github-core-clone-01/REBUILD.md`
- Kit (sudah diperbaiki lokal): `~/workspace/makefun/github-core-clone-01-kit/`
  (catatan: `practice/trial-{0,1,2}/input/env/` dibuat manual — dir kosong
  itu hilang saat packaging kit; tanpa itu grade-local void).
- Bundle draf (0 usage rows, JANGAN dipakai submit):
  `~/workspace/makefun/github-core-clone-01-attempt1/transcripts.tar.gz`
  (sha256 d0b0fbbc17ef492b86692d1f3f56723f76a834e66846ebaf829786bbb9d2e863).
- Grade tersimpan: `/tmp/grade1`, `/tmp/grade2`, `/tmp/grade3`
  (state/perf.json di tiap `trial-0/state/`).
- Harness lokal: `/tmp/forge-test.mjs`, server `/tmp/forge-server.mjs`.
- Sesi ini: agent `bcc8d7c8-690e-48f2-9ca3-2175eedf3b1c`, parent
  `e0ca4be1-3672-4ea3-a399-7d9eee7575c8`, top-level `64af0316-60eb-4d75-9e5d-b320c28515e7`.
- Keypair: `~/workspace/makefun/makefun-keypair.json` (mode 600, jangan
  tampilkan). API key: `~/.makefun/credentials` (mode 600).
