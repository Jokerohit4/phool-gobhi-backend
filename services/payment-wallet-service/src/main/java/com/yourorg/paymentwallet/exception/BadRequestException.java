package com.yourorg.paymentwallet.exception;

import org.springframework.http.HttpStatus;

public class BadRequestException extends BaseApiException {
  public BadRequestException(String message) {
    super(HttpStatus.BAD_REQUEST, "BAD_REQUEST", message);
  }
}
