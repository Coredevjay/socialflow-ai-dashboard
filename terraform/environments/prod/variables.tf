variable "aws_region"  { type = string; default = "us-east-1" }
variable "account_id"  { type = string }
variable "image_uri"   { type = string }
variable "db_name"     { type = string; default = "socialflow" }
variable "db_username" { type = string; default = "socialflow" }
variable "db_password" { type = string; sensitive = true }
variable "jwt_secret"  { type = string; sensitive = true }
variable "jwt_refresh_secret" { type = string; sensitive = true }
variable "csrf_secret"        { type = string; sensitive = true }
variable "stripe_secret_key"  { type = string; sensitive = true }
variable "twitter_api_key"    { type = string; sensitive = true }
variable "twitter_api_secret" { type = string; sensitive = true }
variable "service_domain" {
  type        = string
  description = "Domain name for the service (e.g. api.socialflow.ai)"
}
variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone ID for DNS validation of the ACM certificate"
}
variable "terraform_trusted_principals" {
  type        = list(string)
  description = "AWS principals trusted to assume the Terraform executor role for prod environment"
  default     = []
}
