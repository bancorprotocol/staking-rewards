const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const DB_DIR = path.resolve(__dirname, '../data');

class DB {
    constructor(name) {
        this.dbPath = path.join(DB_DIR, `${name}.json`);

        if (fs.existsSync(this.dbPath)) {
            const release = lockfile.lockSync(this.dbPath, { retries: { forever: true } });

            const rawData = fs.readFileSync(this.dbPath);

            this.data = JSON.parse(rawData);
            release();
        } else {
            this.data = {};
        }
    }

    save() {
        fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
    }
}

module.exports = DB;
