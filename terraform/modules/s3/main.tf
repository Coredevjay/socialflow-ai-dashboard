resource "aws_s3_bucket" "main" {
  bucket        = var.bucket_name
  force_destroy = var.env == "dev"
  tags          = { Env = var.env }
}

resource "aws_s3_bucket_versioning" "main" {
  bucket = aws_s3_bucket.main.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "main" {
  bucket = aws_s3_bucket.main.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "main" {
  bucket                  = aws_s3_bucket.main.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Reject any request that is not made over TLS
resource "aws_s3_bucket_policy" "deny_insecure_transport" {
  bucket = aws_s3_bucket.main.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.main.arn,
        "${aws_s3_bucket.main.arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}

# Server access logging is opt-in: set logging_target_bucket to a separate bucket
resource "aws_s3_bucket_logging" "main" {
  count         = var.logging_target_bucket == null ? 0 : 1
  bucket        = aws_s3_bucket.main.id
  target_bucket = var.logging_target_bucket
  target_prefix = "s3-access/${var.bucket_name}/"
}

resource "aws_s3_bucket_lifecycle_configuration" "main" {
  bucket = aws_s3_bucket.main.id

  rule {
    id     = "expire-old-uploads"
    status = "Enabled"
    filter { prefix = "uploads/" }
    expiration { days = var.env == "prod" ? 365 : 30 }
  }

  # Clean up incomplete multipart uploads from any prefix after 1 day
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }

  rule {
    id     = "backup-retention"
    status = "Enabled"
    filter { prefix = "backups/" }

    # Remove current backup objects after 90 days in prod, 30 days elsewhere
    expiration { days = var.env == "prod" ? 90 : 30 }

    # Remove non-current versions (after versioning overwrites) after 90 days
    noncurrent_version_expiration { noncurrent_days = 90 }

    # Clean up incomplete multipart uploads after 1 day
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
