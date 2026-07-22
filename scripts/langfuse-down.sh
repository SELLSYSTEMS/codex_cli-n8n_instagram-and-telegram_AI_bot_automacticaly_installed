#!/usr/bin/env bash
set -euo pipefail
systemctl stop langfuse-native-worker.service langfuse-native-web.service \
  langfuse-native-minio.service langfuse-native-redis.service \
  langfuse-native-clickhouse.service
echo "Local Langfuse stopped."
