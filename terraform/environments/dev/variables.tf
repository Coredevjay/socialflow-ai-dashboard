variable "aws_region"  { type = string; default = "us-east-1" }
variable "account_id"  { type = string }
variable "image_uri"   { type = string }
variable "db_name"     { type = string; default = "socialflow" }
variable "db_username" { type = string; default = "socialflow" }
variable "db_password" { type = string; sensitive = true }
variable "jwt_secret"  { type = string; sensitive = true }
variable "service_domain" {
  type        = string
  description = "Domain name for the service (e.g. api.socialflow.ai)"
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.service_domain))
    error_message = "service_domain must be a valid fully qualified domain name (e.g. api.socialflow.ai)."
  }
}
variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone ID for DNS validation of the ACM certificate"
  validation {
    condition     = can(regex("^Z[A-Z0-9]+$", var.hosted_zone_id))
    error_message = "hosted_zone_id must be a Route53 hosted zone ID (e.g. Z0123456789ABCDEFGHIJ)."
  }
}
variable "terraform_trusted_principals" {
  type        = list(string)
  description = "AWS principals trusted to assume the Terraform executor role for dev environment"
  default     = []
}
