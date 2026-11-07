#!/usr/bin/env bash
# ZeroDrop IPFS Upload to Filebase
# Usage: FILEBASE_KEY=xxx FILEBASE_SECRET=yyy bash scripts/filebase-upload.sh
# Or:    bash scripts/filebase-upload.sh <KEY> <SECRET>

set -euo pipefail

FILEBASE_KEY="${1:-${FILEBASE_KEY:-}}"
FILEBASE_SECRET="${2:-${FILEBASE_SECRET:-}}"
BUCKET="zerodrop"
FILE="apps/web/dist/index.html"
OBJECT_NAME="index.html"
ENDPOINT="https://s3.filebase.com"

if [[ -z "$FILEBASE_KEY" || -z "$FILEBASE_SECRET" ]]; then
  echo "ERROR: Filebase Access Key and Secret Key required."
  echo "  Usage: FILEBASE_KEY=xxx FILEBASE_SECRET=yyy bash scripts/filebase-upload.sh"
  echo "  Get keys at: https://console.filebase.com/keys/api"
  exit 1
fi

# Check the file exists
if [[ ! -f "$FILE" ]]; then
  echo "ERROR: Built frontend not found at $FILE. Run 'pnpm build' first."
  exit 1
fi

FILE_SIZE=$(wc -c < "$FILE")
SHA256=$(shasum -a 256 "$FILE" | awk '{print $1}')
echo "== ZeroDrop Filebase IPFS Upload =="
echo "-> File:    $FILE  ($FILE_SIZE bytes)"
echo "-> SHA-256: $SHA256"
echo "-> Bucket:  $BUCKET"
echo "-> Object:  $OBJECT_NAME"
echo ""

# Check if awscli is available
if command -v aws &>/dev/null; then
  echo "-> Using AWS CLI to upload to Filebase S3..."
  AWS_ACCESS_KEY_ID="$FILEBASE_KEY" \
  AWS_SECRET_ACCESS_KEY="$FILEBASE_SECRET" \
  AWS_DEFAULT_REGION="us-east-1" \
  aws --endpoint-url "$ENDPOINT" s3 cp \
    "$FILE" "s3://$BUCKET/$OBJECT_NAME" \
    --content-type "text/html; charset=utf-8" \
    --no-verify-ssl 2>/dev/null || \
  AWS_ACCESS_KEY_ID="$FILEBASE_KEY" \
  AWS_SECRET_ACCESS_KEY="$FILEBASE_SECRET" \
  AWS_DEFAULT_REGION="us-east-1" \
  aws --endpoint-url "$ENDPOINT" s3 cp \
    "$FILE" "s3://$BUCKET/$OBJECT_NAME" \
    --content-type "text/html; charset=utf-8"
else
  echo "-> AWS CLI not found. Using curl with S3 signature..."
  
  DATE=$(date -u +%Y%m%dT%H%M%SZ)
  DATE_SHORT=$(date -u +%Y%m%d)
  CONTENT_TYPE="text/html; charset=utf-8"
  CONTENT_SHA256=$(shasum -a 256 "$FILE" | awk '{print $1}')
  
  # Build canonical request for AWS Sig V4
  CANONICAL_URI="/$BUCKET/$OBJECT_NAME"
  CANONICAL_HEADERS="content-type:$CONTENT_TYPE\nhost:s3.filebase.com\nx-amz-content-sha256:$CONTENT_SHA256\nx-amz-date:$DATE"
  SIGNED_HEADERS="content-type;host;x-amz-content-sha256;x-amz-date"
  CANONICAL_REQUEST="PUT\n$CANONICAL_URI\n\n$CANONICAL_HEADERS\n\n$SIGNED_HEADERS\n$CONTENT_SHA256"
  
  CREDENTIAL_SCOPE="$DATE_SHORT/us-east-1/s3/aws4_request"
  STRING_TO_SIGN="AWS4-HMAC-SHA256\n$DATE\n$CREDENTIAL_SCOPE\n$(printf '%s' "$CANONICAL_REQUEST" | shasum -a 256 | awk '{print $1}')"
  
  SIGNING_KEY=$(printf '%s' "aws4_request" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(printf '%s' "s3" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(printf '%s' "us-east-1" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(printf '%s' "$DATE_SHORT" | openssl dgst -sha256 -mac HMAC -macopt "key:AWS4$FILEBASE_SECRET" | awk '{print $2}')" | awk '{print $2}')" | awk '{print $2}')" | awk '{print $2}')
  
  SIGNATURE=$(printf '%s' "$STRING_TO_SIGN" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$SIGNING_KEY" | awk '{print $2}')
  AUTH_HEADER="AWS4-HMAC-SHA256 Credential=$FILEBASE_KEY/$CREDENTIAL_SCOPE, SignedHeaders=$SIGNED_HEADERS, Signature=$SIGNATURE"
  
  curl -f -X PUT "$ENDPOINT$CANONICAL_URI" \
    -H "Content-Type: $CONTENT_TYPE" \
    -H "x-amz-date: $DATE" \
    -H "x-amz-content-sha256: $CONTENT_SHA256" \
    -H "Authorization: $AUTH_HEADER" \
    --data-binary "@$FILE"
fi

echo ""
echo "== Upload Complete =="
echo "-> Check the file CID in Filebase dashboard:"
echo "   https://console.filebase.com/buckets/$BUCKET"
echo ""
echo "-> Public gateway links (replace <CID> with actual CID from dashboard):"
echo "   https://ipfs.filebase.io/ipfs/<CID>"
echo "   https://bafybeidyjgm7x2twzydfh7ri7wdma2minhqdbfbactzjyq47jkvj6i2xoy.ipfs.inbrowser.link"

