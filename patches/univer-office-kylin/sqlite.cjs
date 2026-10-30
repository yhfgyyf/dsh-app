// The pinned Univer gateway uses only this synchronous subset of libsql.
// Node 22.16 already embeds SQLite in the Kylin runtime, avoiding a new native addon.
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');

module.exports = class UniverSQLite extends DatabaseSync {
  constructor(filename, options = {}) {
    if (options.fileMustExist && filename !== ':memory:') statSync(filename);
    super(filename, {
      readOnly: options.readonly ?? false,
      timeout: options.timeout ?? 5000,
      // libsql defaults to off; the gateway enables it explicitly for writable files.
      enableForeignKeyConstraints: false,
    });
  }

  get inTransaction() {
    return this.isTransaction;
  }
};
