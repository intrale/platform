# Guía de Distribución Web — Friends & Family

> Canal: **AWS S3 + CloudFront**
> Plataforma objetivo: Browsers modernos (Chrome, Firefox, Safari, Edge)
> Audiencia: ~10-20 testers Friends & Family

---

## Para testers

### ¿Cómo acceder a la app?

1. Recibirás una notificación por Telegram con el link de la app.
2. Abrí el link en cualquier browser (Chrome recomendado).
3. La app funciona como PWA — podés instalarla desde el browser si querés.

### ¿Cómo obtener actualizaciones?

- **Automático**: cada vez que se sube un nuevo build, el link sigue siendo el mismo.
- Si la app no muestra la última versión, hacé **Ctrl+Shift+R** (hard refresh) en el browser.

### Requisitos mínimos

| Browser | Versión mínima |
|---------|---------------|
| Chrome / Chromium | 119+ |
| Firefox | 120+ |
| Safari | 17+ |
| Edge | 119+ |

> La app usa WebAssembly (Wasm). Verificá que tu browser tenga Wasm habilitado (habilitado por defecto en versiones modernas).

---

## Para el equipo de desarrollo

### Infraestructura AWS

| Recurso | Valor |
|---------|-------|
| Bucket S3 | `intrale-web-staging` (us-east-1) |
| Región | `us-east-1` |
| CloudFront | Apunta al bucket S3 |
| Acceso | URL larga no-guessable (seguridad por oscuridad — adecuado para F&F) |
| Costo estimado | <$5/mes para ~10-20 usuarios |

### Secrets de GitHub requeridos

| Secret | Descripción |
|--------|-------------|
| `AWS_S3_BUCKET_WEB` | Nombre del bucket: `intrale-web-staging` |
| `AWS_CLOUDFRONT_DISTRIBUTION_ID` | ID de la distribución CloudFront |
| `AWS_ACCESS_KEY_ID` | Reutilizado del stack AWS existente |
| `AWS_SECRET_ACCESS_KEY` | Reutilizado del stack AWS existente |
| `TELEGRAM_BOT_TOKEN` | Reutilizado de otros workflows |
| `TELEGRAM_CHAT_ID` | Reutilizado de otros workflows |

### Setup de AWS (primera vez)

#### 1. Crear bucket S3

```bash
aws s3 mb s3://intrale-web-staging --region us-east-1
```

#### 2. Configurar bucket para CloudFront

```bash
# Bloquear acceso público directo (solo CloudFront puede acceder)
aws s3api put-public-access-block \
  --bucket intrale-web-staging \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

#### 3. Crear CloudFront Distribution

Desde la consola AWS o con CloudFormation:

- **Origin**: bucket S3 `intrale-web-staging`
- **Origin Access**: Origin Access Control (OAC) — no exponer bucket públicamente
- **Default root object**: `index.html`
- **Error pages**: redirigir 403/404 → `/index.html` (necesario para SPA)
- **Price class**: PriceClass_100 (solo USA/Europa — más barato)
- **Cache policy**: Managed-CachingDisabled (para que las actualizaciones sean inmediatas)

#### 4. Bucket policy para CloudFront OAC

Después de crear la distribución, agregar esta policy al bucket (reemplazar `DISTRIBUTION_ID` y `ACCOUNT_ID`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::intrale-web-staging/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

#### 5. Configurar GitHub Secrets

En GitHub → Settings → Secrets and variables → Actions:

```
AWS_S3_BUCKET_WEB = intrale-web-staging
AWS_CLOUDFRONT_DISTRIBUTION_ID = <ID obtenido al crear la distribución>
```

`AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY` ya deben estar configurados.

---

### Workflow CI/CD

**Archivo**: `.github/workflows/distribute-web.yml`

**Triggers**:
- Push a `main` — deploy automático
- `workflow_dispatch` — deploy manual desde GitHub Actions UI

**Steps**:
1. Checkout del código
2. Setup Java 21 (Temurin)
3. Cache Gradle
4. Build: `./gradlew :app:composeApp:wasmJsBrowserProductionWebpack`
5. Deploy: `aws s3 sync build/dist/wasmJs/productionExecutable/ s3://intrale-web-staging/ --delete`
6. Invalidación CloudFront: `aws cloudfront create-invalidation --paths "/*"`
7. Notificación Telegram con URL de la app

**Output del build** (artefactos a subir):
```
app/composeApp/build/dist/wasmJs/productionExecutable/
```

---

### Consideraciones de seguridad

- **Acceso controlado**: URL larga no-guessable (no indexada, no compartida públicamente).
- **Sin signed URLs**: adecuado para F&F (~10-20 usuarios conocidos). Para producción pública, evaluar CloudFront signed URLs o Cognito-based auth.
- **Bucket privado**: solo accesible via CloudFront (OAC), no directamente.
- **HTTPS**: CloudFront provee TLS automáticamente.

---

### Troubleshooting

| Problema | Solución |
|----------|----------|
| La app no carga / pantalla en blanco | Hard refresh: Ctrl+Shift+R |
| Error 403 / 404 | Verificar bucket policy y error pages en CloudFront |
| Build falla en Gradle | Ver logs en GitHub Actions — puede ser OOM, aumentar heap |
| Invalidación pendiente | CloudFront puede tardar ~1-5 min en propagar |

---

> Referencias:
> - `docs/distribution-strategy.md` — secciones 2.4, 4.3, 6 (checklist Web)
> - Workflow: `.github/workflows/distribute-web.yml`
> - Issue: [#1467](https://github.com/intrale/platform/issues/1467)
