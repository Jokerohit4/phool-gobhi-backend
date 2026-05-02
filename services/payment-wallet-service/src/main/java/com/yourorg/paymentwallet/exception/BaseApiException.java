package com.yourorg.paymentwallet.exception;

import lombok.Getter;
import org.springframework.http.HttpStatus;

@Getter
public abstract class BaseApiException extends RuntimeException implements ApiException {

    private final HttpStatus status;
    private final String errorCode;

    protected BaseApiException(HttpStatus status, String errorCode, String message) {
        super(message);
        this.status = status;
        this.errorCode = errorCode;
    }
}
