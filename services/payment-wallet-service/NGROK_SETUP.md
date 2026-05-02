# Ngrok Setup Guide for Razorpay Webhook Testing

## Prerequisites
- ngrok installed and authenticated (already configured)
- Spring Boot application running on port 8082
- Razorpay test API keys

## Step 1: Update Razorpay Test Keys

Edit `src/main/resources/application.properties` and update:

```properties
razorpay.key.id=YOUR_TEST_KEY_ID
razorpay.key.secret=YOUR_TEST_KEY_SECRET
razorpay.webhook.secret=YOUR_WEBHOOK_SECRET
```

**To get your test keys:**
1. Log in to [Razorpay Dashboard](https://dashboard.razorpay.com/)
2. Go to Settings > API Keys
3. Copy your **Test Key ID** and **Test Key Secret**
4. For webhook secret, go to Settings > Webhooks and create a webhook (you'll get the secret)

## Step 2: Start the Spring Boot Application

```bash
mvn spring-boot:run
```

Or if you have a JAR:
```bash
java -jar target/payment-wallet-service-0.0.1-SNAPSHOT.jar
```

The application will start on `http://localhost:8082`

## Step 3: Start Ngrok Tunnel

Make the script executable (first time only):
```bash
chmod +x start-ngrok.sh
```

Run the ngrok script:
```bash
./start-ngrok.sh
```

Or manually:
```bash
ngrok http 8082
```

## Step 4: Configure Webhook in Razorpay Dashboard

1. Copy the HTTPS URL from ngrok (e.g., `https://xxxx-xx-xx-xx-xx.ngrok-free.app`)
2. Go to [Razorpay Dashboard](https://dashboard.razorpay.com/) > Settings > Webhooks
3. Click "Add New Webhook"
4. Enter the webhook URL: `https://your-ngrok-url.ngrok-free.app/api/payment/webhook`
5. Select events: `payment.captured`, `payment.failed`
6. Copy the **Webhook Secret** and update it in `application.properties`

## Step 5: Test the Webhook

1. Create a payment order via API:
```bash
curl -X POST http://localhost:8082/api/payment/order \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": 1,
    "amount": 100.0,
    "description": "Test payment"
  }'
```

2. Use the `razorpayOrderId` from the response to test payment in Razorpay test mode
3. The webhook will be called automatically when payment succeeds/fails

## Important Notes

- **Ngrok URLs change every time** you restart ngrok (unless you have a paid plan with static domain)
- Update the webhook URL in Razorpay dashboard each time you restart ngrok
- The webhook secret must match between Razorpay dashboard and your `application.properties`
- Webhook signature verification is automatically handled by the application

## Troubleshooting

### Webhook not receiving calls
- Check if ngrok is running and the URL is correct
- Verify the webhook URL in Razorpay dashboard matches your ngrok URL
- Check Spring Boot logs for incoming requests

### Signature verification fails
- Ensure `razorpay.webhook.secret` in `application.properties` matches the secret from Razorpay dashboard
- Check that the webhook secret is correctly configured in Razorpay dashboard

### Port already in use
- Change `server.port` in `application.properties` to a different port
- Update ngrok command: `ngrok http <new-port>`

