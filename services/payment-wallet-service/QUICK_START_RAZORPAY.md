# Razorpay Quick Start Guide

## 🚀 5-Minute Setup

### Step 1: Get Razorpay Keys (2 minutes)

1. Go to https://dashboard.razorpay.com/
2. Login/Sign Up
3. Go to **Settings** → **API Keys**
4. Copy **Test Key ID** (starts with `rzp_test_...`)
5. Copy **Test Key Secret** (shown only once!)

### Step 2: Configure Application (1 minute)

**Option A: Edit `application-local.properties`** (Recommended)
```properties
razorpay.key.id=rzp_test_xxxxxxxxxxxxx
razorpay.key.secret=your_test_key_secret_here
razorpay.webhook.secret=your_webhook_secret_here
```

**Option B: Set Environment Variables**
```bash
export RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
export RAZORPAY_KEY_SECRET=your_test_key_secret
export RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
```

### Step 3: Get Webhook Secret (2 minutes)

1. **Start your application:**
   ```bash
   mvn spring-boot:run
   ```

2. **Start ngrok** (in another terminal):
   ```bash
   ngrok http 8082
   ```

3. **Copy ngrok HTTPS URL** (e.g., `https://xxxx-xx-xx-xx-xx.ngrok-free.app`)

4. **Configure in Razorpay:**
   - Go to Razorpay Dashboard → **Settings** → **Webhooks**
   - Click **Add New Webhook**
   - URL: `https://your-ngrok-url.ngrok-free.app/api/payment/webhook`
   - Events: Select `payment.captured` and `payment.failed`
   - Click **Create**
   - **Copy the Webhook Secret** and add to your config

### Step 4: Test (1 minute)

```bash
# 1. Create wallet
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "userType": "customer", "currency": "INR"}'

# 2. Create payment order
curl -X POST http://localhost:8082/api/payment/order \
  -H "Content-Type: application/json" \
  -d '{"walletId": 1, "amount": 100.00, "description": "Test"}'

# 3. Use razorpayOrderId from response in Razorpay test mode
```

## ✅ Done!

Your payment integration is ready. See `RAZORPAY_INTEGRATION_STEPS.md` for detailed guide.

## 📝 Frontend Integration (Quick)

```javascript
// 1. Include Razorpay script
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>

// 2. Create order and open checkout
async function pay(walletId, amount) {
  // Create order on backend
  const order = await fetch('/api/payment/order', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({walletId, amount, description: 'Topup'})
  }).then(r => r.json());
  
  // Open Razorpay checkout
  const options = {
    key: 'rzp_test_xxxxxxxxxxxxx', // Your Key ID
    amount: amount * 100, // in paise
    currency: 'INR',
    order_id: order.razorpayOrderId,
    handler: function(response) {
      alert('Payment successful!');
    }
  };
  const rzp = new Razorpay(options);
  rzp.open();
}
```

## 🔑 Key Points

- ✅ Use **Test Keys** for development
- ✅ Use **ngrok** for local webhook testing
- ✅ **Webhook Secret** must match in both places
- ✅ Amount in Razorpay is in **paise** (multiply by 100)
- ✅ Webhook handles payment automatically

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| "Credentials are null" | Check config file or env variables |
| "Invalid webhook signature" | Verify webhook secret matches |
| Webhook not received | Check ngrok is running, URL is correct |
| Payment not crediting wallet | Check webhook was received, use verify endpoint |

See `RAZORPAY_INTEGRATION_STEPS.md` for detailed troubleshooting.

