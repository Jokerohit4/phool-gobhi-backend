# Quick Start Guide - Razorpay + Ngrok Setup

## Step 1: Update Razorpay Test Keys

Edit `src/main/resources/application.properties`:

```properties
razorpay.key.id=rzp_test_xxxxxxxxxxxxx
razorpay.key.secret=xxxxxxxxxxxxxxxxxxxxx
razorpay.webhook.secret=xxxxxxxxxxxxxxxxxxxxx
```

**Where to find these:**
- **Test Key ID & Secret**: Razorpay Dashboard → Settings → API Keys → Test Keys
- **Webhook Secret**: Will be generated when you create a webhook (Step 4)

## Step 2: Start Your Application

```bash
mvn spring-boot:run
```

Application will run on `http://localhost:8082`

## Step 3: Start Ngrok

```bash
./start-ngrok.sh
```

Or manually:
```bash
ngrok http 8082
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok-free.app`)

## Step 4: Configure Webhook in Razorpay

1. Go to [Razorpay Dashboard](https://dashboard.razorpay.com/) → Settings → Webhooks
2. Click "Add New Webhook"
3. **Webhook URL**: `https://your-ngrok-url.ngrok-free.app/api/payment/webhook`
4. **Select Events**: 
   - ✅ `payment.captured`
   - ✅ `payment.failed`
5. Click "Create Webhook"
6. **Copy the Webhook Secret** and update `razorpay.webhook.secret` in `application.properties`
7. Restart your application

## Step 5: Test the Integration

### Create a Payment Order:
```bash
curl -X POST http://localhost:8082/api/payment/order \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": 1,
    "amount": 100.0,
    "description": "Test payment"
  }'
```

### Response will include `razorpayOrderId` - use this in Razorpay test mode

## Important Notes

⚠️ **Ngrok URLs change** every time you restart ngrok (free plan)
- Update webhook URL in Razorpay dashboard each time
- Or use ngrok static domain (paid plan)

✅ **Webhook signature verification** is automatically handled
✅ **Duplicate payment processing** is prevented
✅ **Both webhook formats supported** (Razorpay standard + simple test format)

## Troubleshooting

**Webhook not receiving calls?**
- Check ngrok is running
- Verify webhook URL in Razorpay dashboard
- Check application logs

**Signature verification fails?**
- Ensure webhook secret matches between Razorpay and `application.properties`
- Restart application after updating webhook secret

**Port 8082 in use?**
- Change `server.port` in `application.properties`
- Update ngrok: `ngrok http <new-port>`

