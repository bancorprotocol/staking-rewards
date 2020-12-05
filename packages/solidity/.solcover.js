const memdown = require('memdown');

module.exports = {
    providerOptions: {
        db: memdown(),
        default_balance_ether: 10000000000000000000
    }
};
