package com.yourorg.paymentwallet.service;

import com.yourorg.paymentwallet.exception.BadRequestException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@Service
public class RazorpayWebhookService {
    
    private final String webhookSecret;
    
    public RazorpayWebhookService(@Value("${razorpay.webhook.secret}") String webhookSecret) {
        this.webhookSecret = webhookSecret;
    }
    
    /**
     * Verifies the Razorpay webhook signature
     * @param orderId Razorpay order ID
     * @param paymentId Razorpay payment ID
     * @param signature Signature received from Razorpay
     * @return true if signature is valid, false otherwise
     */
    public boolean verifySignature(String orderId, String paymentId, String signature) {
        if (orderId == null || paymentId == null || signature == null || webhookSecret == null) {
            return false;
        }
        
        try {
            String payload = orderId + "|" + paymentId;
            String generatedSignature = calculateHMAC(payload, webhookSecret);
            
            return MessageDigest.isEqual(
                    generatedSignature.getBytes(StandardCharsets.UTF_8),
                    signature.getBytes(StandardCharsets.UTF_8)
            );
        } catch (Exception e) {
            throw new BadRequestException("Error verifying webhook signature: " + e.getMessage());
        }
    }
    
    /**
     * Verifies Razorpay webhook signature from raw request body
     * @param requestBody Raw JSON request body as string
     * @param signature Signature from X-Razorpay-Signature header
     * @return true if signature is valid, false otherwise
     */
    public boolean verifyWebhookSignature(String requestBody, String signature) {
        if (requestBody == null || signature == null || webhookSecret == null) {
            return false;
        }
        
        try {
            String generatedSignature = calculateHMAC(requestBody, webhookSecret);
            
            return MessageDigest.isEqual(
                    generatedSignature.getBytes(StandardCharsets.UTF_8),
                    signature.getBytes(StandardCharsets.UTF_8)
            );
        } catch (Exception e) {
            throw new BadRequestException("Error verifying webhook signature: " + e.getMessage());
        }
    }
    
    /**
     * Calculates HMAC SHA256 signature
     */
    private String calculateHMAC(String data, String secret) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        SecretKeySpec secretKeySpec = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        mac.init(secretKeySpec);
        byte[] hash = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        
        StringBuilder hexString = new StringBuilder();
        for (byte b : hash) {
            String hex = Integer.toHexString(0xff & b);
            if (hex.length() == 1) {
                hexString.append('0');
            }
            hexString.append(hex);
        }
        return hexString.toString();
    }
}

