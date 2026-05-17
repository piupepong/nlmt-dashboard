# NLMT Dashboard

Dashboard tinh cho he thong nang luong mat troi.

## Kien truc moi

- Render chay `render-worker.js`.
- Worker nghe ESPHome SSE tai `ESPHOME_EVENT_URL`.
- Worker ghi mau moi len Supabase moi phut vao bang `energy_samples`.
- Web tinh chi doc Supabase, lay dong moi nhat khi nguoi dung mo trang, sau do cap nhat bang Supabase Realtime va poll du phong moi 60 giay.

## Render env vars

Bat buoc:

```text
ESPHOME_EVENT_URL=https://piupepong.ddnsfree.com/events
SUPABASE_URL=https://iopqamrtcuxntcojtqeu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_TABLE=energy_samples
DEVICE_ID=nlmt-main
SAMPLE_INTERVAL_MS=60000
```

Nen dung `SUPABASE_SERVICE_ROLE_KEY` tren Render, khong dua key nay vao frontend.

## Supabase

Bang `energy_samples` can co unique constraint:

```sql
unique (device_id, ts)
```

De web cap nhat realtime, bat Realtime cho bang `energy_samples` trong Supabase.
