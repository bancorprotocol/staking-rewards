const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const Contract = require('web3-eth-contract');
const { set, get } = require('lodash');

const { trace, info, error, warning, arg } = require('../utils/logger');

const ETH_RESERVE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MKR_RESERVE_ADDRESS = '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2';

const BATCH_SIZE = 500;

const REMOVE_LIQUIDITY_SELECTOR = '0x782ed90c';
const REMOVE_LIQUIDITY_ABI = [
    {
        type: 'uint256',
        name: 'id'
    },
    {
        type: 'uint32',
        name: 'portion'
    }
];

const PPM_RESOLUTION = new BN(1000000);

const getLiquidityTask = async (env) => {
    const getPosition = async (id, blockNumber) => {
        const position = await web3Provider.call(
            contracts.LiquidityProtectionStore.methods.protectedLiquidity(id),
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
        const { positions, liquidity, pools } = data;

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

            const events = await web3Provider.getPastEvents(contracts.LiquidityProtectionStore, 'allEvents', {
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
                        const poolAmount = returnValues._poolAmount;
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

                        // Try to find the new positions which didn't exist in the previous block and match them to
                        // this position.
                        let matches = [];
                        const currentBlockIds = await web3Provider.call(
                            contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                            {},
                            blockNumber
                        );
                        const prevBLockIds = await web3Provider.call(
                            contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                            {},
                            blockNumber - 1
                        );
                        const ids = currentBlockIds.filter((id) => !prevBLockIds.includes(id));

                        // If the we can't find to position in the current block, we can assume that it was created
                        // and transferred out in the same block, which means we'd get it in the next
                        // ProtectionAdded event. If this position was added and removed in the same block (which
                        // should be no longer possible in the newer versions), it's ok to ignore it since it won't
                        // be eligible for any rewards anyway.
                        if (currentBlockIds.length === 0) {
                            warning('Position no longer exists. Ignoring');

                            continue;
                        }

                        for (const id of ids) {
                            const position = await getPosition(id, blockNumber);

                            if (
                                position.poolToken === poolToken &&
                                position.reserveToken === reserveToken &&
                                new BN(position.poolAmount).eq(new BN(poolAmount)) &&
                                new BN(position.reserveAmount).eq(new BN(reserveAmount))
                            ) {
                                // If the creation time is different, then we're handling an obsoleted transfer
                                // liquidity event.
                                if (position.timestamp != timestamp) {
                                    warning('Potentially unexpected transfer liquidity event');
                                }

                                matches.push(id);
                            }
                        }

                        if (matches.length === 0) {
                            error(
                                'Failed to fully match position. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        } else if (matches.length > 1) {
                            warning(
                                'Found more than a single exact match. Assuming that the entry belongs to the first unknown position',
                                arg('matches', matches.length)
                            );

                            // We've have found two identical position additions in the same block, so as long as
                            // we'd take the non-existing IDs first - we should be fine.
                            matches = matches.filter((id) => !positions[id]);
                        }

                        const id = matches[0];
                        const position = {
                            provider,
                            poolToken,
                            reserveToken,
                            poolAmount,
                            reserveAmount,
                            timestamp
                        };

                        trace(
                            'New position',
                            arg('id', id),
                            arg('provider', position.provider),
                            arg('poolToken', position.poolToken),
                            arg('reserveToken', position.reserveToken),
                            arg('poolAmount', position.poolAmount),
                            arg('reserveAmount', position.reserveAmount),
                            arg('timestamp', position.timestamp)
                        );

                        positions[id] = position;

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

                        if (new BN(newReserveAmount).gte(new BN(prevReserveAmount))) {
                            error('Updated liquidity can only decrease the entire reserve token amount');
                        }

                        // Try to find the pool and reserves tokens by matching the position in a previous block.
                        // Please note that we are assuming that a single position wasn't added and removed in the
                        // same block.
                        const matches = [];
                        const prevBlock = blockNumber - 1;
                        let ids = await web3Provider.call(
                            contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                            {},
                            prevBlock
                        );
                        for (const id of ids) {
                            const position = await getPosition(id, prevBlock);
                            if (
                                new BN(position.reserveAmount).eq(new BN(prevReserveAmount)) &&
                                new BN(position.poolAmount).eq(new BN(prevPoolAmount))
                            ) {
                                matches.push(id);
                            }
                        }

                        if (matches.length === 0) {
                            warning(
                                'Failed to fully match position. Trying to look for an updated position in the same block (assuming no more than a two updates in the same block)'
                            );

                            ids = await web3Provider.call(
                                contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                                {},
                                blockNumber
                            );
                            for (const id of ids) {
                                const position = await getPosition(id, blockNumber);
                                if (
                                    new BN(position.reserveAmount).eq(new BN(newReserveAmount)) &&
                                    new BN(position.poolAmount).eq(new BN(newPoolAmount))
                                ) {
                                    matches.push(id);
                                }
                            }

                            if (matches.length !== 1) {
                                error(
                                    'Failed to fully match position. Expected to find a single match, but found',
                                    arg('matches', matches.length)
                                );
                            }
                        } else if (matches.length !== 1) {
                            error(
                                'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const id = matches[0];
                        const position = positions[id];
                        const portion = new BN(prevReserveAmount)
                            .sub(new BN(newReserveAmount))
                            .mul(new BN(PPM_RESOLUTION))
                            .div(new BN(prevReserveAmount));

                        const { poolToken, reserveToken } = position;

                        liquidity.push({
                            event: 'Remove',
                            id,
                            portion: portion.toString(),
                            blockNumber,
                            timestamp,
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount: new BN(prevReserveAmount).sub(new BN(newReserveAmount)).toString()
                        });

                        trace(
                            'Position updated',
                            arg('id', id),
                            arg('portion', portion),
                            arg('provider', position.provider),
                            arg('poolToken', position.poolToken),
                            arg('reserveToken', position.reserveToken),
                            arg('poolAmount', position.poolAmount),
                            arg('reserveAmount', position.reserveAmount),
                            arg('timestamp', position.timestamp)
                        );

                        position.poolAmount = new BN(newPoolAmount).toString();
                        position.reserveAmount = new BN(newReserveAmount).toString();

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

                        // Try to find the position ID that existed in the previous block, but doesn't exist now.
                        // Please note that we are ignore the case when a single position was added and removed in the
                        // same block.
                        let matches = [];
                        const currentBlockIds = await web3Provider.call(
                            contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                            {},
                            blockNumber
                        );
                        const prevBLockIds = await web3Provider.call(
                            contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                            {},
                            blockNumber - 1
                        );
                        const ids = prevBLockIds.filter((id) => !currentBlockIds.includes(id));

                        // If the we can't find to position in the previous block, we can assume that it was created
                        // and transferred out in the same block, which means we'd get it in the next
                        // ProtectionAdded event. If this position was added and removed in the same block (which
                        // should be no longer possible in the newer versions), it's ok to ignore it since it won't
                        // be eligible for any rewards anyway.
                        if (prevBLockIds.length === 0) {
                            warning('Position did not exist. Ignoring');

                            continue;
                        }

                        for (const id of ids) {
                            const position = positions[id];

                            if (
                                provider === position.provider &&
                                position.poolToken === poolToken &&
                                position.reserveToken === reserveToken &&
                                new BN(position.poolAmount).eq(new BN(poolAmount)) &&
                                new BN(position.reserveAmount).eq(new BN(reserveAmount))
                            ) {
                                matches.push(id);
                            }
                        }

                        if (matches.length > 1) {
                            warning('Found too many matching position IDs. Attempting to decode the ID from tx data');

                            const tx = await web3Provider.getTransaction(transactionHash);
                            const { input } = tx;

                            if (!input.startsWith(REMOVE_LIQUIDITY_SELECTOR)) {
                                error('Failed to decode transaction', arg('tx', transactionHash));
                            }

                            const rawParams = input.slice(REMOVE_LIQUIDITY_SELECTOR.length);
                            const params = web3Provider.decodeParameters(REMOVE_LIQUIDITY_ABI, `0x${rawParams}`);

                            const { id } = params;
                            const position = positions[id];

                            if (
                                provider === position.provider &&
                                position.poolToken === poolToken &&
                                position.reserveToken === reserveToken &&
                                new BN(position.poolAmount).eq(new BN(poolAmount)) &&
                                new BN(position.reserveAmount).eq(new BN(reserveAmount))
                            ) {
                                matches = [id];
                            } else {
                                error('Failed to match the decoded ID to the event', arg('id', id));
                            }
                        } else if (matches.length !== 1) {
                            error(
                                'Failed to fully match position ID. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const id = matches[0];
                        const position = positions[id];
                        const portion = new BN(position.reserveAmount)
                            .mul(new BN(PPM_RESOLUTION))
                            .div(new BN(reserveAmount));

                        if (!new BN(portion).eq(PPM_RESOLUTION)) {
                            error(
                                'Remove liquidity can only remove the whole liquidity',
                                arg('id', id),
                                arg('portion', portion),
                                arg('poolToken', position.poolToken),
                                arg('reserveToken', position.reserveToken),
                                '[',
                                arg('expected', position.reserveAmount),
                                arg('actual', reserveAmount),
                                ']'
                            );
                        }

                        if (!new BN(position.reserveAmount).eq(new BN(reserveAmount))) {
                            error(
                                'Remove liquidity can only decrease the entire reserve token amount for',
                                arg('id', id),
                                arg('portion', portion),
                                arg('poolToken', position.poolToken),
                                arg('reserveToken', position.reserveToken),
                                '[',
                                arg('expected', position.reserveAmount),
                                arg('actual', reserveAmount),
                                ']'
                            );
                        }

                        trace(
                            'Position removed',
                            arg('id', id),
                            arg('portion', portion),
                            arg('provider', position.provider),
                            arg('poolToken', position.poolToken),
                            arg('reserveToken', position.reserveToken),
                            arg('poolAmount', position.poolAmount),
                            arg('reserveAmount', position.reserveAmount),
                            arg('timestamp', position.timestamp)
                        );

                        position.poolAmount = 0;
                        position.reserveAmount = 0;

                        liquidity.push({
                            event: 'Remove',
                            id,
                            portion: portion.toString(),
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
            const change1 = liquidity[i];
            const change2 = liquidity[i + 1];

            if (change1.blockNumber > change2.blockNumber || change1.timestamp > change2.timestamp) {
                error('Wrong events order', arg('change1', change1), arg('change2', change2));
            }
        }

        // Verify positions.
        for (const change of liquidity) {
            const { event } = change;
            if (event !== 'Remove') {
                continue;
            }

            const { id, portion, blockNumber, provider, poolToken, reserveToken, reserveAmount } = change;

            const position = await getPosition(id, blockNumber - 1);
            const newPosition = await getPosition(id, blockNumber);

            if (position.provider != provider) {
                error("Position providers don't match", arg('expected', provider), arg('actual', position.provider));
            }

            if (position.poolToken != poolToken) {
                error(
                    "Position pool tokens don't match",
                    arg('expected', poolToken),
                    arg('actual', position.poolToken)
                );
            }

            if (position.reserveToken != reserveToken) {
                error(
                    "Position reserve tokens don't match",
                    arg('expected', reserveToken),
                    arg('actual', position.reserveToken)
                );
            }
            const actualReserveAmount = new BN(position.reserveAmount).sub(new BN(newPosition.reserveAmount));
            if (actualReserveAmount.eq(reserveAmount)) {
                error(
                    "Position reserve amounts don't match",
                    arg('expected', reserveAmount),
                    arg('actual', actualReserveAmount)
                );
            }
        }
    };

    const getProtectedLiquidity = async (data, fromBlock, toBlock) => {
        if (!data.positions) {
            data.positions = {};
        }

        if (!data.liquidity) {
            data.liquidity = [];
        }

        if (!data.pools) {
            data.pools = {};
        }

        await getProtectionLiquidityChanges(data, fromBlock, toBlock);
        await verifyProtectionLiquidityChanges(data);

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

module.exports = getLiquidityTask;
