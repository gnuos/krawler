class CustomError extends Error {
  message;

  constructor(message) {
    super(message);
    this.message = message;
    Error.captureStackTrace(this, this.constructor);
  }
}

function makeError(name) {
  const errFactory = CustomError;
  errFactory.prototype.name = name;

  return errFactory;
}

const HttpError = makeError('HttpError');
const RequestError = makeError('RequestError');
const HandlersError = makeError('HandlersError');

export { HttpError, RequestError, HandlersError };
