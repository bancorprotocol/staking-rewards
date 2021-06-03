const { trace, info, error, arg } = require('../utils/logger');
const BN = require('bn.js');
const DB = require('../utils/db');

const BATCH_SIZE = 15;

const storePoolRewardsTask = async (env, { poolToken }) => {
    const storePoolRewards = async (data) => {
        info('Storing pool rewards for', arg('poolToken', poolToken), arg('batchSize', BATCH_SIZE));

        let totalGas = 0;

        let providers = [];
        for (const provider of Object.keys(data.pendingRewards)) {
            const rewards = await web3Provider.call(
                contracts.StakingRewards.methods.pendingPoolRewards(provider, poolToken)
            );

            if (new BN(rewards).eq(new BN(0))) {
                trace('Skipping provider without any pending rewards', arg('provider', provider));

                continue;
            }

            providers.push(provider);
        }

        for (let i = 0; i < providers.length; i += BATCH_SIZE) {
            const providersBatch = providers.slice(i, i + BATCH_SIZE);

            for (const provider of providersBatch) {
                trace('Storing provider pool rewards for', arg('provider', provider), arg('poolToken', poolToken));
            }

            const tx = await web3Provider.send(
                contracts.StakingRewards.methods.storePoolRewards(providersBatch, poolToken)
            );

            totalGas += tx.gasUsed;
        }

        info('Finished storing pool rewards', arg('totalGas', totalGas), arg('providers', providers.length));
    };

    const { web3Provider, contracts } = env;

    if (!poolToken) {
        error('Invalid pool token address');
    }

    const db = new DB(`${poolToken}-pending-rewards`);

    await storePoolRewards(db.data);
};

module.exports = storePoolRewardsTask;
