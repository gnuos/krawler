import makeError from './utils.mjs';

export default {
  HttpError: makeError('HttpError'),
  RequestError: makeError('RequestError'),
  HandlersError: makeError('HandlersError')
};
