# Razorpay Integration - Step by Step Guide

## 📋 Prerequisites
- Razorpay account (Sign up at https://razorpay.com)
- Java 17+ installed
- Maven installed
- PostgreSQL database running
- ngrok (for local webhook testing)

---

## Step 1: Create Razorpay Account

1. **Sign Up**
   - Go to https://razorpay.com
   - Click "Sign Up" or "Get Started"
   - Fill in your business details
   - Verify your email and phone number

2. **Complete KYC** (for production)
   - Go to Settings → Account & Settings
   - Complete business verification
   - Upload required documents
   - Wait for approval (usually 24-48 hours)

---

## Step 2: Get API Keys

### For Testing (Test Mode)

1. **Access Test Keys**
   - Login to Razorpay Dashboard
   - Go to **Settings** → **API Keys**
   - You'll see **Test Mode** section

2. **Generate Test Keys** (if not already generated)
   - Click "Generate Test Key"
   - Copy the **Key ID** (starts with `rzp_test_...`)
   - Copy the **Key Secret** (starts with `...` - shown only once!)

3. **Save Keys Securely**
   ```
   Test Key ID: rzp_test_xxxxxxxxxxxxx
   Test Key Secret: xxxxxxxxxxxxxxxxxxxxxxxx
   ```

### For Production (Live Mode)

1. **Activate Live Mode**
   - Complete KYC first
   - Go to Settings → API Keys
   - Switch to **Live Mode**

2. **Generate Live Keys**
   - Click "Generate Live Key"
   - Copy **Key ID** (starts with `rzp_live_...`)
   - Copy **Key Secret** (shown only once!)

---

## Step 3: Configure Backend Application

### Option A: Using application.properties (Local Development)

1. **Edit `application.properties`**
   ```properties
   # Razorpay Configuration
   razorpay.key.id=rzp_test_xxxxxxxxxxxxx
   razorpay.key.secret=your_test_key_secret_here
   razorpay.webhook.secret=your_webhook_secret_here
   ```

2. **Or use `application-local.properties`** (recommended for local)
   ```properties
   # Razorpay Test Keys
   razorpay.key.id=rzp_test_xxxxxxxxxxxxx
   razorpay.key.secret=your_test_key_secret_here
   razorpay.webhook.secret=your_webhook_secret_here
   ```

### Option B: Using Environment Variables (Production - Recommended)

1. **Set Environment Variables**
   ```bash
   export RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxx
   export RAZORPAY_KEY_SECRET=your_live_key_secret
   export RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
   ```

2. **Or in your deployment platform:**
   - **Heroku**: Settings → Config Vars
   - **AWS**: Environment Variables in EC2/ECS
   - **Docker**: Use `-e` flag or `.env` file
   - **Kubernetes**: ConfigMap or Secrets

### Option C: Using application.properties with Placeholders

Your current `application.properties` already supports environment variables:
```properties
razorpay.key.id=${RAZORPAY_KEY_ID:}
razorpay.key.secret=${RAZORPAY_KEY_SECRET:}
razorpay.webhook.secret=${RAZORPAY_WEBHOOK_SECRET:}
```

This means:
- If environment variables are set, they'll be used
- If not, empty string (you'll get an error - which is good for security)

---

## Step 4: Get Webhook Secret

### For Local Testing (with ngrok)

1. **Set up ngrok** (see NGROK_SETUP.md for details)
   ```bash
   ngrok http 8082
   ```

2. **Copy ngrok URL**
   ```
   https://xxxx-xx-xx-xx-xx.ngrok-free.app
   ```

3. **Configure Webhook in Razorpay**
   - Go to Razorpay Dashboard → **Settings** → **Webhooks**
   - Click **Add New Webhook**
   - **Webhook URL**: `https://xxxx-xx-xx-xx-xx.ngrok-free.app/api/payment/webhook`
   - **Active Events**: Select
     - ✅ `payment.captured`
     - ✅ `payment.failed`
   - Click **Create Webhook**

4. **Copy Webhook Secret**
   - After creating webhook, you'll see a **Webhook Secret**
   - Copy it and add to your configuration

### For Production

1. **Configure Production Webhook**
   - Go to Razorpay Dashboard → **Settings** → **Webhooks**
   - Add webhook URL: `https://your-domain.com/api/payment/webhook`
   - Select events: `payment.captured`, `payment.failed`
   - Copy the **Webhook Secret**

---

## Step 5: Test the Integration

### 5.1 Start Your Application

```bash
# Using Maven
mvn spring-boot:run

# Or with local profile
mvn spring-boot:run -Dspring-boot.run.profiles=local

# Or build and run
mvn clean package
java -jar target/payment-wallet-service-0.0.1-SNAPSHOT.jar
```

### 5.2 Verify Configuration

Check logs for:
```
========== RAZORPAY CONFIG DEBUG ==========
Key ID length: 28
Key ID starts with: rzp_test_xxxxx
Key Secret length: 32
Key Secret starts with: xxxxx
==========================================
```

If you see errors, check:
- Keys are correctly set
- No extra spaces in configuration
- Environment variables are exported (if using them)

### 5.3 Test Payment Flow

1. **Create a Wallet**
   ```bash
   curl -X POST http://localhost:8082/api/wallet \
     -H "Content-Type: application/json" \
     -d '{
       "userId": 1,
       "userType": "customer",
       "currency": "INR"
     }'
   ```

2. **Create Payment Order**
   ```bash
   curl -X POST http://localhost:8082/api/payment/order \
     -H "Content-Type: application/json" \
     -d '{
       "walletId": 1,
       "amount": 100.00,
       "description": "Test payment"
     }'
   ```

   **Response:**
   ```json
   {
     "id": 1,
     "razorpayOrderId": "order_xxxxxxxxxxxxx",
     "walletId": 1,
     "amount": 100.00,
     "status": "PENDING"
   }
   ```

3. **Test Payment in Razorpay Test Mode**
   - Use Razorpay Test Cards: https://razorpay.com/docs/payments/test-cards/
   - Or use Razorpay Checkout (see Frontend Integration below)

4. **Verify Webhook Received**
   - Check application logs for webhook processing
   - Check wallet balance: `GET /api/wallet/1`
   - Check transactions: `GET /api/wallet/1/transactions`

---

## Step 6: Frontend Integration

### 6.1 Include Razorpay Checkout Script

Add to your HTML:
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

### 6.2 Create Payment Order (Backend Call)

```javascript
async function createPaymentOrder(walletId, amount, description) {
  const response = await fetch('http://localhost:8082/api/payment/order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      walletId: walletId,
      amount: amount,
      description: description
    })
  });
  
  return await response.json();
}
```

### 6.3 Initialize Razorpay Checkout

```javascript
async function initiatePayment(walletId, amount) {
  try {
    // Step 1: Create order on your backend
    const order = await createPaymentOrder(walletId, amount, "Wallet topup");
    
    // Step 2: Initialize Razorpay Checkout
    const options = {
      "key": "rzp_test_xxxxxxxxxxxxx", // Your Razorpay Key ID
      "amount": amount * 100, // Amount in paise (multiply by 100)
      "currency": "INR",
      "name": "Your Company Name",
      "description": "Wallet Topup",
      "order_id": order.razorpayOrderId, // From backend response
      "handler": function (response) {
        // Payment successful
        console.log("Payment ID:", response.razorpay_payment_id);
        console.log("Order ID:", response.razorpay_order_id);
        console.log("Signature:", response.razorpay_signature);
        
        // Verify payment on backend (optional - webhook handles it)
        verifyPayment(response.razorpay_order_id);
      },
      "prefill": {
        "name": "Customer Name",
        "email": "customer@example.com",
        "contact": "9999999999"
      },
      "theme": {
        "color": "#3399cc"
      },
      "modal": {
        "ondismiss": function() {
          console.log("Payment cancelled");
        }
      }
    };
    
    const rzp = new Razorpay(options);
    rzp.open();
    
  } catch (error) {
    console.error("Payment initiation failed:", error);
  }
}
```

### 6.4 Verify Payment (Optional - Webhook handles it automatically)

```javascript
async function verifyPayment(razorpayOrderId) {
  try {
    const response = await fetch(
      `http://localhost:8082/api/payment/order/${razorpayOrderId}/verify`,
      {
        method: 'GET'
      }
    );
    
    const order = await response.json();
    console.log("Payment status:", order.status);
    
    if (order.status === 'CAPTURED') {
      // Update UI - payment successful
      alert('Payment successful!');
      // Refresh wallet balance
      loadWalletBalance();
    }
  } catch (error) {
    console.error("Payment verification failed:", error);
  }
}
```

### 6.5 Complete Example (React)

```jsx
import React, { useState } from 'react';

function PaymentButton({ walletId, amount }) {
  const [loading, setLoading] = useState(false);

  const handlePayment = async () => {
    setLoading(true);
    try {
      // Create order
      const orderResponse = await fetch('http://localhost:8082/api/payment/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletId: walletId,
          amount: amount,
          description: 'Wallet topup'
        })
      });
      
      const order = await orderResponse.json();
      
      // Initialize Razorpay
      const options = {
        key: 'rzp_test_xxxxxxxxxxxxx', // Your Key ID
        amount: amount * 100,
        currency: 'INR',
        name: 'Your App',
        description: 'Wallet Topup',
        order_id: order.razorpayOrderId,
        handler: function(response) {
          alert('Payment successful!');
          // Refresh page or update state
          window.location.reload();
        },
        prefill: {
          name: 'User Name',
          email: 'user@example.com',
          contact: '9999999999'
        }
      };
      
      const rzp = new window.Razorpay(options);
      rzp.open();
      
    } catch (error) {
      console.error('Payment failed:', error);
      alert('Payment initiation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handlePayment} disabled={loading}>
      {loading ? 'Processing...' : `Pay ₹${amount}`}
    </button>
  );
}
```

---

## Step 7: Production Deployment

### 7.1 Switch to Live Mode

1. **Update Configuration**
   ```properties
   # Use Live Keys
   razorpay.key.id=${RAZORPAY_KEY_ID:}
   razorpay.key.secret=${RAZORPAY_KEY_SECRET:}
   razorpay.webhook.secret=${RAZORPAY_WEBHOOK_SECRET:}
   ```

2. **Set Environment Variables**
   ```bash
   export RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxx
   export RAZORPAY_KEY_SECRET=your_live_secret
   export RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
   ```

### 7.2 Update Frontend

Change Razorpay Key ID in frontend:
```javascript
const options = {
  key: 'rzp_live_xxxxxxxxxxxxx', // Live Key ID
  // ... rest of options
};
```

### 7.3 Configure Production Webhook

1. Go to Razorpay Dashboard → Settings → Webhooks
2. Add production webhook URL: `https://your-domain.com/api/payment/webhook`
3. Select events: `payment.captured`, `payment.failed`
4. Copy webhook secret to your production environment

### 7.4 SSL Certificate

- Ensure your production domain has valid SSL certificate
- Razorpay requires HTTPS for webhooks
- Use Let's Encrypt or your hosting provider's SSL

---

## Step 8: Testing Checklist

### Test Mode Testing

- [ ] Create payment order successfully
- [ ] Razorpay checkout opens correctly
- [ ] Test payment with test cards
- [ ] Webhook received and processed
- [ ] Wallet balance updated
- [ ] Transaction recorded
- [ ] Payment verification works
- [ ] Refund functionality works

### Test Cards (Razorpay)

**Success Cards:**
- Card Number: `4111 1111 1111 1111`
- CVV: Any 3 digits
- Expiry: Any future date
- Name: Any name

**Failure Cards:**
- Card Number: `4000 0000 0000 0002` (Payment failed)
- Card Number: `4000 0000 0000 0069` (Card declined)

### Production Testing

- [ ] Test with small amount first (₹1)
- [ ] Verify webhook received
- [ ] Check wallet balance updated
- [ ] Test refund functionality
- [ ] Monitor logs for errors

---

## Step 9: Troubleshooting

### Common Issues

1. **"Razorpay credentials are null"**
   - Check environment variables are set
   - Verify application.properties has correct keys
   - Restart application after changing config

2. **"Invalid webhook signature"**
   - Verify webhook secret is correct
   - Check webhook URL matches exactly
   - Ensure raw request body is used for signature verification

3. **Webhook not received**
   - Check ngrok is running (for local)
   - Verify webhook URL in Razorpay dashboard
   - Check firewall/security groups allow incoming requests
   - Check application logs for errors

4. **Payment created but wallet not credited**
   - Check webhook was received
   - Use verify endpoint: `GET /api/payment/order/{id}/verify`
   - Check application logs for errors
   - Verify wallet exists

5. **"Order not found" errors**
   - Ensure razorpayOrderId is correct
   - Check order was created in database
   - Verify order ID format (starts with `order_`)

### Debug Mode

Enable debug logging in `application.properties`:
```properties
logging.level.com.yourorg.paymentwallet=DEBUG
logging.level.com.razorpay=DEBUG
```

---

## Step 10: Security Best Practices

1. **Never commit API keys to Git**
   - Use environment variables
   - Use `.gitignore` for local config files
   - Use secrets management in production

2. **Use HTTPS in Production**
   - Required for webhooks
   - Required for PCI compliance

3. **Validate Webhook Signatures**
   - Always verify webhook signatures
   - Never trust webhook data without verification

4. **Use Test Mode for Development**
   - Never use live keys in development
   - Test thoroughly before switching to live

5. **Monitor Transactions**
   - Set up alerts for failed payments
   - Monitor webhook processing
   - Review transaction logs regularly

---

## 📚 Additional Resources

- **Razorpay Documentation**: https://razorpay.com/docs/
- **Test Cards**: https://razorpay.com/docs/payments/test-cards/
- **Webhook Events**: https://razorpay.com/docs/webhooks/
- **API Reference**: https://razorpay.com/docs/api/

---

## ✅ Integration Complete!

Your payment integration is now ready. Follow these steps in order, and you'll have a fully functional payment system integrated with Razorpay.

**Quick Start Summary:**
1. Get Razorpay API keys (test mode)
2. Configure in application.properties
3. Set up webhook (use ngrok for local)
4. Test payment flow
5. Integrate frontend
6. Deploy to production with live keys

Need help? Check the troubleshooting section or Razorpay support.

