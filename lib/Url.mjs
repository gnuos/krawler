import { createHash } from 'node:crypto';

class Url {
  _url;
  _statusCode;
  _errorCode;
  _errorMessage;
  _encoded;
  _parent;

  /**
   * Represents a URL, that is either waiting to be crawled or has already
   * been crawled. It also contains some state information, i.e. whether or not
   * the page was crawled, status code, etc.
   *
   * @param {Object|string} opts Options about this URL. Can also be string URL.
   */
  constructor(opts) {
    if (typeof opts === 'string') {
      opts = {
        url: opts
      };
    }

    this._url = opts.url;
    this._statusCode = opts.statusCode ? opts.statusCode : null;
    this._errorCode = opts.errorCode ? opts.errorCode : null;
    this._errorMessage = opts.errorMessage ? opts.errorMessage : null;

    this._parent = opts.parent || undefined;
    this._encoded = createHash('sha256').update(this._url).copy().digest('hex');
  }

  getParent() {
    return this._parent;
  }

  /**
   * Get the string that uniquely identifies this record; typically the URL.
   * This will ensure that the object is replaced when added to a \UrlList.
   *
   * @return {string} Unique identifier
   */
  getUniqueId() {
    return this._encoded;
  }

  /**
   * Get the string URL that is to be requested.
   *
   * @return {string} URL.
   */
  getUrl() {
    return this._url;
  }

  /**
   * Get the error code of the the crawl.
   *
   * @return {string|null} String error code, or null if no error.
   */
  getErrorCode() {
    return this._errorCode;
  }

  /**
   * Return the status code of the crawl.
   *
   * @return {number|null} Status code, or null if crawl hasn't completed.
   */
  getStatusCode() {
    return this._statusCode;
  }

  /**
   * Return the error message of the URL.
   *
   * @return {string} Error message string.
   */
  getErrorMessage() {
    if (typeof this._errorMessage === 'string') {
      return this._errorMessage.substring(0, 1000);
    }

    return null;
  }
}

export default Url;
