# Razorpay Setup Checklist

Use this checklist to ensure your Razorpay integration is complete.

## Pre-Integration
- [ ] Created Razorpay account
- [ ] Completed KYC (for production)
- [ ] Have Razorpay dashboard access

## Configuration
- [ ] Got Test Key ID from Razorpay Dashboard
- [ ] Got Test Key Secret from Razorpay Dashboard
- [ ] Configured `razorpay.key.id` in application.properties or env variable
- [ ] Configured `razorpay.key.secret` in application.properties or env variable
- [ ] Application starts without Razorpay config errors

## Webhook Setup (Local Testing)
- [ ] Application running on port 8082
- [ ] ngrok installed and running
- [ ] ngrok tunnel active (https://xxxx.ngrok-free.app)
- [ ] Created webhook in Razorpay Dashboard
- [ ] Webhook URL: `https://your-ngrok-url.ngrok-free.app/api/payment/webhook`
- [ ] Selected events: `payment.captured`, `payment.failed`
- [ ] Copied Webhook Secret
- [ ] Configured `razorpay.webhook.secret` in application.properties

## Testing
- [ ] Created wallet successfully
- [ ] Created payment order successfully
- [ ] Razorpay checkout opens correctly
- [ ] Test payment completed with test card
- [ ] Webhook received (check application logs)
- [ ] Wallet balance updated after payment
- [ ] Transaction recorded in database
- [ ] Payment verification endpoint works

## Frontend Integration
- [ ] Razorpay checkout script included
- [ ] Payment order creation API integrated
- [ ] Razorpay checkout initialized with correct Key ID
- [ ] Payment success handler implemented
- [ ] Error handling implemented

## Production (When Ready)
- [ ] Completed KYC verification
- [ ] Generated Live API Keys
- [ ] Updated configuration with Live Keys
- [ ] Configured production webhook URL
- [ ] Updated frontend with Live Key ID
- [ ] SSL certificate configured
- [ ] Tested with small amount in production
- [ ] Monitoring and alerts set up

## Security
- [ ] API keys not committed to Git
- [ ] Using environment variables or secure config
- [ ] Webhook signature verification working
- [ ] HTTPS enabled in production
- [ ] Test keys only used in development

---

**Status:** ⬜ Not Started | 🟡 In Progress | ✅ Complete

Track your progress and check off items as you complete them!
