#!/bin/bash

# Script to start ngrok tunnel for Razorpay webhook testing
# This will expose your local server on port 8082 to the internet

echo "Starting ngrok tunnel on port 8082..."
echo "Your webhook URL will be displayed below."
echo ""
echo "Copy the HTTPS URL (e.g., https://xxxx-xx-xx-xx-xx.ngrok-free.app)"
echo "and configure it in Razorpay Dashboard > Settings > Webhooks"
echo ""
echo "Press Ctrl+C to stop ngrok"
echo ""

ngrok http 8082

