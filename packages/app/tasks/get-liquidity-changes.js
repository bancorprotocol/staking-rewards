const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const Contract = require('web3-eth-contract');
const { set, get } = require('lodash');

const { trace, info, error, warning, arg } = require('../utils/logger');

const ETH_RESERVE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MKR_RESERVE_ADDRESS = '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2';

const BATCH_SIZE = 500;

const getLiquidityChangesTask = async (env, verify = true) => {
    const getPosition = async (id, blockNumber) => {
        const position = await web3Provider.call(
            contracts.LiquidityProtectionStoreOld.methods.protectedLiquidity(id),
            {},
            blockNumber
        );

        return {
            id,
            provider: position[0],
            poolToken: position[1],
            reserveToken: position[2],
            poolAmount: position[3],
            reserveAmount: position[4],
            reserveRateN: position[5],
            reserveRateD: position[6],
            timestamp: position[7]
        };
    };

    const getTokenInfo = async (token) => {
        const eq = (address1, address2) => {
            return address1.toLowerCase() === address2.toLowerCase();
        };

        let name;
        let symbol;
        if (eq(token, ETH_RESERVE_ADDRESS)) {
            name = 'Ethereum Reserve';
            symbol = 'ETH';
        } else if (eq(token, MKR_RESERVE_ADDRESS)) {
            name = 'MakerDAO';
            symbol = 'MKR';
        } else {
            const ERC20Token = new Contract(ERC20_ABI, token);
            name = await web3Provider.call(ERC20Token.methods.name());
            symbol = await web3Provider.call(ERC20Token.methods.symbol());
        }

        return { name, symbol };
    };

    const getProtectionLiquidityChanges = async (data, fromBlock, toBlock) => {
        const { liquidity, pools } = data;

        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += BATCH_SIZE) {
            const endBlock = Math.min(i + BATCH_SIZE - 1, toBlock);

            info(
                'Querying all protection change events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', BATCH_SIZE),
                'blocks'
            );

            const events = await web3Provider.getPastEvents(contracts.LiquidityProtectionStoreOld, 'allEvents', {
                fromBlock: i,
                toBlock: endBlock
            });

            for (const event of events) {
                const { blockNumber, returnValues, transactionHash } = event;
                const block = await web3Provider.getBlock(blockNumber);
                const { timestamp } = block;

                switch (event.event) {
                    case 'ProtectionAdded': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionAdded event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        liquidity.push({
                            event: 'Add',
                            blockNumber,
                            timestamp,
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount: reserveAmount.toString()
                        });

                        if (!get(pools, [poolToken])) {
                            set(pools, [poolToken], await getTokenInfo(poolToken));
                        }

                        if (!get(pools, [poolToken, reserveToken])) {
                            set(pools, [poolToken, reserveToken], await getTokenInfo(reserveToken));
                        }

                        eventCount++;

                        break;
                    }

                    case 'ProtectionUpdated': {
                        const provider = returnValues._provider;
                        const prevReserveAmount = returnValues._prevReserveAmount;
                        const newReserveAmount = returnValues._newReserveAmount;
                        const prevPoolAmount = returnValues._prevPoolAmount;
                        const newPoolAmount = returnValues._newPoolAmount;

                        trace(
                            'Found ProtectionUpdated event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('prevPoolAmount', prevPoolAmount),
                            arg('newPoolAmount', newPoolAmount),
                            arg('prevReserveAmount', prevReserveAmount),
                            arg('newReserveAmount', newReserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        // Try to find the pool and reserves tokens by matching the position in a previous block.
                        // Please note that we are assuming that a single position wasn't added and removed in the
                        // same block.
                        const matches = [];
                        const prevBlock = blockNumber - 1;
                        let ids = await web3Provider.call(
                            contracts.LiquidityProtectionStoreOld.methods.protectedLiquidityIds(provider),
                            {},
                            prevBlock
                        );
                        for (const id of ids) {
                            const position = await getPosition(id, prevBlock);
                            if (
                                new BN(position.reserveAmount).eq(new BN(prevReserveAmount)) &&
                                new BN(position.poolAmount).eq(new BN(prevPoolAmount))
                            ) {
                                matches.push({
                                    poolToken: position.poolToken,
                                    reserveToken: position.reserveToken
                                });
                            }
                        }

                        if (matches.length === 0) {
                            warning(
                                'Failed to fully match pool and reserve tokens. Trying to look for an updated position in the same block (assuming no more than a two updates in the same block)'
                            );

                            ids = await web3Provider.call(
                                contracts.LiquidityProtectionStoreOld.methods.protectedLiquidityIds(provider),
                                {},
                                blockNumber
                            );
                            for (const id of ids) {
                                const position = await getPosition(id, blockNumber);
                                if (
                                    new BN(position.reserveAmount).eq(new BN(newReserveAmount)) &&
                                    new BN(position.poolAmount).eq(new BN(newPoolAmount))
                                ) {
                                    matches.push({
                                        poolToken: position.poolToken,
                                        reserveToken: position.reserveToken
                                    });
                                }
                            }

                            if (matches.length !== 1) {
                                error(
                                    'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                    arg('matches', matches.length)
                                );
                            }
                        } else if (matches.length !== 1) {
                            error(
                                'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const { poolToken, reserveToken } = matches[0];

                        liquidity.push({
                            event: 'Remove',
                            blockNumber,
                            timestamp,
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount: new BN(prevReserveAmount).sub(new BN(newReserveAmount)).toString()
                        });

                        eventCount++;

                        break;
                    }

                    case 'ProtectionRemoved': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const poolAmount = returnValues._poolAmount;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionRemoved event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('poolAmount', poolAmount),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        liquidity.push({
                            event: 'Remove',
                            blockNumber,
                            timestamp,
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount: reserveAmount.toString()
                        });

                        eventCount++;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new protection change events', arg('count', eventCount));
    };

    const verifyProtectionLiquidityChanges = async (data) => {
        const { liquidity } = data;

        info('Verifying all new protection change events', arg('blockNumber', toBlock));

        // Verify that the events are sorted in an ascending order.
        for (let i = 0; i + 1 < liquidity.length - 1; ++i) {
            const event1 = liquidity[i];
            const event2 = liquidity[i + 1];

            if (event1.blockNumber > event2.blockNumber || event1.timestamp > event2.timestamp) {
                error('Wrong events order', arg('event1', event1), arg('event2', event2));
            }
        }
    };

    const getProtectedLiquidity = async (data, fromBlock, toBlock) => {
        if (!data.liquidity) {
            data.liquidity = [];
        }

        if (!data.pools) {
            data.pools = {};
        }

        await getProtectionLiquidityChanges(data, fromBlock, toBlock);

        if (verify) {
            await verifyProtectionLiquidityChanges(data);
        }

        data.lastBlockNumber = toBlock;
    };

    const { settings, web3Provider, reorgOffset, contracts, test } = env;

    if (test) {
        warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');
    }

    const externalContractsDir = path.resolve(
        __dirname,
        '../../../node_modules/@bancor/contracts/solidity/build/contracts'
    );

    const rawData = fs.readFileSync(path.join(externalContractsDir, 'ERC20Token.json'));
    const { abi: ERC20_ABI } = JSON.parse(rawData);

    const dbDir = path.resolve(__dirname, '../data');
    const dbPath = path.join(dbDir, 'liquidity.json');
    let data = {};
    if (fs.existsSync(dbPath)) {
        const rawData = fs.readFileSync(dbPath);
        data = JSON.parse(rawData);
    }

    let fromBlock;
    if (!data.lastBlockNumber) {
        warning('DB last block number is missing. Starting from the beginning');
        fromBlock = settings.genesisBlock;
    } else {
        fromBlock = data.lastBlockNumber + 1;
    }

    const latestBlock = await web3Provider.getBlockNumber();
    if (latestBlock === 0) {
        error('Node is out of sync. Please try again later');
    }

    const toBlock = latestBlock - reorgOffset;
    if (toBlock - fromBlock < reorgOffset) {
        error(
            'Unable to satisfy the reorg window. Please wait for additional',
            arg('blocks', reorgOffset - (toBlock - fromBlock + 1)),
            'to pass'
        );
    }

    info('Getting protected liquidity from', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

    await getProtectedLiquidity(data, fromBlock, toBlock);

    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

module.exports = getLiquidityChangesTask;
