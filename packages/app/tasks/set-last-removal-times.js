const BN = require('bn.js');

const { info, trace, error, arg } = require('../utils/logger');
const DB = require('../utils/db');

const BATCH_SIZE = 200;

const setLastRemovalTimesTask = async (env) => {
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

            const tx = await web3Provider.send(
                contracts.CheckpointStore.methods.addPastCheckpoints(providersBatch, timestampsBatch)
            );
            totalGas += tx.gasUsed;
        }

        info('Finished setting all new last removal times', arg('totalGas', totalGas));
    };

    const verifyLastRemovalTimes = async (lastRemovalTimes) => {
        info('Verifying last removal times');

        for (const [provider, data] of Object.entries(lastRemovalTimes)) {
            trace('Verifying last removal time for', arg('provider', provider));

            const { timestamp } = data;

            const lastRemovalTime = await web3Provider.call(contracts.CheckpointStore.methods.checkpoint(provider));
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

    const { contracts, web3Provider } = env;

    const db = new DB('last-removal-times');
    const { lastRemovalTimes } = db.data;

    await setLastRemovalTimes(lastRemovalTimes);
    await verifyLastRemovalTimes(lastRemovalTimes);
};

module.exports = setLastRemovalTimesTask;
