const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const { fromWei } = require('web3-utils');

const { info, trace, error, arg } = require('../utils/logger');

const BATCH_SIZE = 200;

const setLastRemovalTimes = async (env) => {
    const setLastRemovalTimes = async (lastRemovalTimes) => {
        info('Setting last removal times in batches of', arg('batchSize', BATCH_SIZE));

        let totalGas = 0;

        const entries = Object.entries(lastRemovalTimes);
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_SIZE);
            const providersBatch = batch.map((e) => e[0]);
            const timestampsBatch = batch.map((e) => e[1].timestamp);

            for (let j = 0; j < providersBatch.length; ++j) {
                const provider = providersBatch[j];
                const timestamp = timestampsBatch[j];

                trace('Setting last removal time for', arg('provider', provider), arg('timestamp', timestamp));
            }

            const gas = await contracts.CheckpointStore.methods
                .addPastCheckpoints(providersBatch, timestampsBatch)
                .estimateGas({ from: defaultAccount });
            const tx = await contracts.CheckpointStore.methods
                .addPastCheckpoints(providersBatch, timestampsBatch)
                .send({ from: defaultAccount, gas, gasPrice });
            totalGas += tx.gasUsed;
        }

        info('Finished setting all new last removal times', arg('totalGas', totalGas));
    };

    const verifyLastRemovalTimes = async (lastRemovalTimes) => {
        info('Verifying positions');

        for (const [provider, data] of Object.entries(lastRemovalTimes)) {
            trace('Verifying last removal time for', arg('provider', provider));

            const { timestamp } = data;

            const lastRemovalTime = await contracts.CheckpointStore.methods.checkpoint(provider).call({});
            if (!new BN(lastRemovalTime).eq(new BN(timestamp))) {
                error(
                    "Last removal times don't match",
                    arg('provider', provider),
                    arg('expected', timestamp),
                    arg('actual', lastRemovalTime)
                );
            }
        }
    };

    const { contracts, defaultAccount, gasPrice } = env;

    if (!gasPrice) {
        error("Gas price isn't set. Aborting");
    }

    info(
        'Gas price is set to',
        arg('gasPrice', gasPrice),
        '(wei)',
        arg('gasPrice', fromWei(gasPrice.toString(), 'gwei')),
        '(gwei)'
    );

    const dbDir = path.resolve(__dirname, '../data');
    const dbPath = path.join(dbDir, 'last-removal-times.json');
    if (!fs.existsSync(dbPath)) {
        error('Unable to locate', arg('db', dbPath));
    }

    const { lastRemovalTimes } = JSON.parse(fs.readFileSync(dbPath));

    await setLastRemovalTimes(lastRemovalTimes);
    await verifyLastRemovalTimes(lastRemovalTimes);
};

module.exports = setLastRemovalTimes;
