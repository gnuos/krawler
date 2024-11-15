class CustomError extends Error {
  message;

  constructor(message) {
    super(message);
    this.message = message;
    Error.captureStackTrace(this, this.constructor);
  }
}

export default function (name) {
  const errFactory = CustomError;
  errFactory.prototype.name = name;

  return errFactory;
}
