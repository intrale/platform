#!/usr/bin/env bash
# Script idempotente: crea tablas DynamoDB, Cognito User Pool y datos seed.
# Corre dentro del container amazon/aws-cli vía docker-compose.
set -euo pipefail

DYNAMO_ENDPOINT="http://dynamodb-local:8000"
COGNITO_ENDPOINT="http://moto:5000"
REGION="us-east-1"

echo "=== Inicializando entorno local ==="

# --- DynamoDB: crear tablas (idempotente) ---
create_table() {
  local table_name="$1"
  local pk_name="$2"

  if aws dynamodb describe-table --table-name "$table_name" \
      --endpoint-url "$DYNAMO_ENDPOINT" --region "$REGION" >/dev/null 2>&1; then
    echo "  Tabla '$table_name' ya existe — omitiendo"
  else
    aws dynamodb create-table \
      --table-name "$table_name" \
      --attribute-definitions "AttributeName=$pk_name,AttributeType=S" \
      --key-schema "AttributeName=$pk_name,KeyType=HASH" \
      --billing-mode PAY_PER_REQUEST \
      --endpoint-url "$DYNAMO_ENDPOINT" \
      --region "$REGION" >/dev/null
    echo "  Tabla '$table_name' creada (pk: $pk_name)"
  fi
}

echo "[1/3] Creando tablas DynamoDB..."
create_table "business" "name"
create_table "users" "email"
create_table "userbusinessprofile" "compositeKey"

# --- Cognito: crear User Pool + App Client ---
echo "[2/3] Creando Cognito User Pool..."

EXISTING_POOLS=$(aws cognito-idp list-user-pools --max-results 10 \
  --endpoint-url "$COGNITO_ENDPOINT" --region "$REGION" \
  --query "UserPools[?Name=='intrale-local'].Id" --output text 2>/dev/null || echo "")

if [ -n "$EXISTING_POOLS" ] && [ "$EXISTING_POOLS" != "None" ]; then
  USER_POOL_ID="$EXISTING_POOLS"
  echo "  User Pool ya existe: $USER_POOL_ID"
else
  USER_POOL_ID=$(aws cognito-idp create-user-pool \
    --pool-name "intrale-local" \
    --auto-verified-attributes email \
    --username-attributes email \
    --endpoint-url "$COGNITO_ENDPOINT" --region "$REGION" \
    --query "UserPool.Id" --output text)
  echo "  User Pool creado: $USER_POOL_ID"
fi

# App Client
EXISTING_CLIENTS=$(aws cognito-idp list-user-pool-clients \
  --user-pool-id "$USER_POOL_ID" --max-results 10 \
  --endpoint-url "$COGNITO_ENDPOINT" --region "$REGION" \
  --query "UserPoolClients[?ClientName=='intrale-local-app'].ClientId" --output text 2>/dev/null || echo "")

if [ -n "$EXISTING_CLIENTS" ] && [ "$EXISTING_CLIENTS" != "None" ]; then
  CLIENT_ID="$EXISTING_CLIENTS"
  echo "  App Client ya existe: $CLIENT_ID"
else
  CLIENT_ID=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-name "intrale-local-app" \
    --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --endpoint-url "$COGNITO_ENDPOINT" --region "$REGION" \
    --query "UserPoolClient.ClientId" --output text)
  echo "  App Client creado: $CLIENT_ID"
fi

# --- Seed data ---
echo "[3/3] Insertando datos seed..."

# Negocio "intrale" en DynamoDB
aws dynamodb put-item \
  --table-name "business" \
  --item '{
    "name": {"S": "intrale"},
    "businessId": {"S": "intrale-001"},
    "publicId": {"S": "intrale"},
    "emailAdmin": {"S": "admin@intrale.com"},
    "description": {"S": "Intrale (local dev)"},
    "state": {"S": "APPROVED"},
    "autoAcceptDeliveries": {"BOOL": false}
  }' \
  --endpoint-url "$DYNAMO_ENDPOINT" --region "$REGION" >/dev/null
echo "  Business 'intrale' insertado"

# Usuario en Cognito
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "admin@intrale.com" \
  --temporary-password "Admin1234!" \
  --user-attributes Name=email,Value=admin@intrale.com Name=email_verified,Value=true \
  --endpoint-url "$COGNITO_ENDPOINT" --region "$REGION" >/dev/null 2>&1 || true
echo "  Usuario 'admin@intrale.com' creado (password temporal: Admin1234!)"

# Usuario en DynamoDB
aws dynamodb put-item \
  --table-name "users" \
  --item '{
    "email": {"S": "admin@intrale.com"},
    "name": {"S": "Admin"},
    "familyName": {"S": "Intrale"},
    "enabled": {"BOOL": true}
  }' \
  --endpoint-url "$DYNAMO_ENDPOINT" --region "$REGION" >/dev/null
echo "  User 'admin@intrale.com' insertado en DynamoDB"

# Perfil
aws dynamodb put-item \
  --table-name "userbusinessprofile" \
  --item '{
    "compositeKey": {"S": "admin@intrale.com#intrale#DEFAULT"},
    "email": {"S": "admin@intrale.com"},
    "business": {"S": "intrale"},
    "profile": {"S": "DEFAULT"},
    "state": {"S": "APPROVED"}
  }' \
  --endpoint-url "$DYNAMO_ENDPOINT" --region "$REGION" >/dev/null
echo "  Perfil 'admin@intrale.com#intrale#DEFAULT' insertado"

echo ""
echo "=== Entorno local listo ==="
echo "  USER_POOL_ID=$USER_POOL_ID"
echo "  CLIENT_ID=$CLIENT_ID"
echo ""
echo "Variables de entorno para el backend:"
echo "  LOCAL_MODE=true"
echo "  REGION_VALUE=us-east-1"
echo "  ACCESS_KEY_ID=local"
echo "  SECRET_ACCESS_KEY=local"
echo "  USER_POOL_ID=$USER_POOL_ID"
echo "  CLIENT_ID=$CLIENT_ID"
echo "  DYNAMODB_ENDPOINT=http://localhost:8000"
echo "  COGNITO_ENDPOINT=http://localhost:5050"
