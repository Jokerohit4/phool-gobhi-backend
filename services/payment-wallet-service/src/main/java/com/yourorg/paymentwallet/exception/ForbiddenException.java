package com.yourorg.paymentwallet.exception;

import org.springframework.http.HttpStatus;

public class ForbiddenException extends BaseApiException {
    public ForbiddenException(String message) {
        super(HttpStatus.FORBIDDEN, "FORBIDDEN", message);
    }
}
