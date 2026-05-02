# API Testing with cURL Commands

## Prerequisites
- Application running on `http://localhost:8082`
- For local testing, use: `mvn spring-boot:run -Dspring-boot.run.profiles=local`

## Quick Test Script
Run all tests at once:
```bash
chmod +x test-api.sh
./test-api.sh
```

## Individual cURL Commands

### 1. Health Check
```bash
curl -X GET http://localhost:8082/api/wallet/health
```

### 2. Create Wallet
```bash
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "userType": "customer",
    "currency": "INR"
  }'
```

### 3. Get Wallet
```bash
curl -X GET http://localhost:8082/api/wallet/1
```

### 4. Credit Wallet
```bash
curl -X POST http://localhost:8082/api/wallet/1/credit \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 1000.0,
    "description": "Initial deposit"
  }'
```

### 5. Debit Wallet
```bash
curl -X POST http://localhost:8082/api/wallet/1/debit \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 250.0,
    "description": "Purchase"
  }'
```

### 6. Get Transactions
```bash
curl -X GET http://localhost:8082/api/wallet/1/transactions
```

### 7. Create Payment Order (Razorpay)
```bash
curl -X POST http://localhost:8082/api/payment/order \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": 1,
    "amount": 500.0,
    "description": "Wallet topup"
  }'
```

**Response will include:**
- `id`: Payment order ID
- `razorpayOrderId`: Razorpay order ID (use this for payment)
- `amount`: Order amount
- `status`: Order status (PENDING)

### 8. Test Webhook (Manual Test)
```bash
# Simple format (for testing)
curl -X POST http://localhost:8082/api/payment/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "razorpay_order_id": "order_xxxxx",
    "razorpay_payment_id": "pay_xxxxx",
    "razorpay_signature": "signature_xxxxx"
  }'
```

**Note:** For actual Razorpay webhooks, use your ngrok URL:
```bash
curl -X POST https://your-ngrok-url.ngrok-free.app/api/payment/webhook \
  -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: your_signature" \
  -d '{
    "event": "payment.captured",
    "payload": {
      "payment": {
        "entity": {
          "id": "pay_xxxxx",
          "order_id": "order_xxxxx",
          "status": "captured",
          "amount": 50000
        }
      }
    }
  }'
```

## Error Testing

### Get Non-existent Wallet
```bash
curl -X GET http://localhost:8082/api/wallet/999
```
**Expected:** 404 Not Found

### Debit with Insufficient Balance
```bash
curl -X POST http://localhost:8082/api/wallet/1/debit \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100000.0,
    "description": "Large purchase"
  }'
```
**Expected:** 400 Bad Request - Insufficient Balance

### Invalid Request Data
```bash
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{
    "userId": null,
    "userType": "",
    "currency": "INVALID"
  }'
```
**Expected:** 400 Bad Request - Validation Error

### Create Duplicate Wallet
```bash
# Create wallet for user 1
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "userType": "customer",
    "currency": "INR"
  }'

# Try to create again (should fail)
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "userType": "customer",
    "currency": "INR"
  }'
```
**Expected:** 409 Conflict - Wallet Already Exists

## Testing with Different User Types

### Create Partner Wallet
```bash
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 2,
    "userType": "partner",
    "currency": "INR"
  }'
```

### Create Gobhi Wallet
```bash
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 3,
    "userType": "gobhi",
    "currency": "INR"
  }'
```

## Pretty Print JSON Responses

Add `| jq` to format JSON responses (requires jq):
```bash
curl -X GET http://localhost:8082/api/wallet/1 | jq
```

Or use Python:
```bash
curl -X GET http://localhost:8082/api/wallet/1 | python -m json.tool
```

## Testing Payment Flow

### Complete Payment Flow:
1. **Create Wallet:**
```bash
curl -X POST http://localhost:8082/api/wallet \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "userType": "customer", "currency": "INR"}'
```

2. **Create Payment Order:**
```bash
curl -X POST http://localhost:8082/api/payment/order \
  -H "Content-Type: application/json" \
  -d '{"walletId": 1, "amount": 500.0, "description": "Topup"}'
```

3. **Use the `razorpayOrderId` from response** to complete payment in Razorpay test mode

4. **Webhook will be called automatically** by Razorpay (if ngrok is configured)

5. **Verify Wallet Balance:**
```bash
curl -X GET http://localhost:8082/api/wallet/1
```

6. **Check Transactions:**
```bash
curl -X GET http://localhost:8082/api/wallet/1/transactions
```

