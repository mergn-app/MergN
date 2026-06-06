# workflow

## Kurulum

```bash
npm install
```

## Kullanım

```bash
npm run server          # backend (.env yükler) — http://localhost:8787
cd web && npm run dev   # frontend (Vite) — http://localhost:5173
```

## Deployment (Docker)

Tek imaj backend + derlenmiş web'i tek porttan (8787) servis eder.

```bash
docker compose up --build   # app + mongo + minio → http://localhost:8787
```

Stack tamamen self-contained: state MongoDB (`DocStore`) ve MinIO/S3'te (`Vault`)
durur, app stateless'tır — sunucu değişse de data volume'larda/managed serviste kalır.

Storage env ile seçilir (`.env.example`'a bak):

| env | default | mongo/s3 modu |
|-----|---------|---------------|
| `STORE_DRIVER` | `file` | `mongo` (+ `MONGO_URL`, `MONGO_DB`) |
| `VAULT_DRIVER` | `doc` | `s3` (+ `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, AWS creds) |

**Managed'a geçiş (sunucu değişebilir senaryosu):** `docker-compose.yml`'den `mongo`
+ `minio` + `createbuckets` servislerini sil, `MONGO_URL`'i Atlas'a, `S3_ENDPOINT`/creds'i
R2/S3'e yönelt. App imajı aynı kalır.
