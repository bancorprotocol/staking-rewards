const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const Web3 = require('web3');
const Contract = require('web3-eth-contract');

const { trace, info, error, warning, notice, arg } = require('../../utils/logger');
const settings = require('../../settings.json');

web3 = new Web3(settings.web3Provider);
BN = web3.utils.BN;
Contract.setProvider(settings.web3Provider);

const main = async () => {
    try {
        const ETH_RESERVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        const MKR_RESERVE_ADDRESS = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';

        const LiquidityProtectionStore = new Contract(
            settings.contracts.LiquidityProtectionStore.abi,
            settings.contracts.LiquidityProtectionStore.address
        );

        const getPosition = async (id, blockNumber) => {
            const position = await LiquidityProtectionStore.methods.protectedLiquidity(id).call({}, blockNumber);

            return {
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

        const getReserveTokenInfo = async (reserveToken) => {
            let name;
            let symbol;
            if (reserveToken === ETH_RESERVE_ADDRESS) {
                name = 'Ethereum Reserve';
                symbol = 'ETH';
            } else if (reserveToken === MKR_RESERVE_ADDRESS) {
                name = 'MakerDAO';
                symbol = 'MKR';
            } else {
                const ReserveToken = new Contract(settings.contracts.ERC20.abi, reserveToken);
                name = await ReserveToken.methods.name().call();
                symbol = await ReserveToken.methods.symbol().call();
            }

            return { name, symbol };
        };

        const getProtectionLiquidityChanges = async (data, fromBlock, toBlock) => {
            const batchSize = 5000;
            let eventCount = 0;
            for (let i = fromBlock; i < toBlock; i += batchSize) {
                const endBlock = Math.min(i + batchSize - 1, toBlock);

                notice(
                    'Querying for all protection change events from',
                    arg('startBlock', i),
                    'to',
                    arg('endBlock', endBlock),
                    'in batches of',
                    arg('batchSize', batchSize),
                    'blocks'
                );

                const events = await LiquidityProtectionStore.getPastEvents('allEvents', {
                    fromBlock: i,
                    toBlock: endBlock
                });

                for (const event of events) {
                    const { blockNumber, returnValues, transactionHash } = event;
                    const block = await web3.eth.getBlock(blockNumber);
                    const { timestamp } = block;

                    switch (event.event) {
                        case 'ProtectionAdded': {
                            const poolToken = returnValues._poolToken;
                            const reserveToken = returnValues._reserveToken;
                            const reserveAmount = returnValues._reserveAmount;

                            trace(
                                'Found ProtectionAdded event at block',
                                arg('blockNumber', blockNumber),
                                arg('poolToken', poolToken),
                                arg('reserveToken', reserveToken),
                                arg('reserveAmount', reserveAmount),
                                arg('timestamp', timestamp),
                                arg('tx', transactionHash)
                            );

                            if (!data.liquidity[poolToken]) {
                                const PoolToken = new Contract(settings.contracts.ERC20.abi, poolToken);
                                const name = await PoolToken.methods.name().call();
                                const symbol = await PoolToken.methods.symbol().call();
                                data.liquidity[poolToken] = { name, symbol };
                            }

                            const poolTokenRecord = data.liquidity[poolToken];
                            if (!poolTokenRecord[reserveToken]) {
                                const { name, symbol } = await getReserveTokenInfo(reserveToken);
                                poolTokenRecord[reserveToken] = { name, symbol, currentAmount: 0, snapshots: {} };
                            }

                            const reserveTokenRecord = poolTokenRecord[reserveToken];
                            reserveTokenRecord.currentAmount = new BN(reserveTokenRecord.currentAmount)
                                .add(new BN(reserveAmount))
                                .toString();

                            reserveTokenRecord.snapshots[timestamp] = reserveTokenRecord.currentAmount;

                            eventCount++;

                            break;
                        }

                        case 'ProtectionUpdated': {
                            const provider = returnValues._provider;
                            const prevReserveAmount = returnValues._prevReserveAmount;
                            const newReserveAmount = returnValues._newReserveAmount;
                            const prevPoolAmount = returnValues._prevPoolAmount;

                            trace(
                                'Found ProtectionUpdated event at block',
                                arg('blockNumber', blockNumber),
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
                            const ids = await LiquidityProtectionStore.methods
                                .protectedLiquidityIds(provider)
                                .call({}, prevBlock);
                            for (const id of ids) {
                                const position = await getPosition(id, prevBlock);
                                if (
                                    new BN(position.reserveAmount).eq(new BN(new BN(prevReserveAmount))) &&
                                    new BN(position.poolAmount).eq(new BN(new BN(prevPoolAmount)))
                                ) {
                                    matches.push({
                                        poolToken: position.poolToken,
                                        reserveToken: position.reserveToken
                                    });
                                }
                            }

                            if (matches.length !== 1) {
                                throw new Error(
                                    `Failed to fully match pool and reserve tokens. Expected to find 1 match, but found ${matches.length} matches. Aborting`
                                );
                            }

                            const { poolToken, reserveToken } = matches[0];
                            const poolTokenRecord = data.liquidity[poolToken];
                            const reserveTokenRecord = poolTokenRecord[reserveToken];

                            if (new BN(reserveTokenRecord.currentAmount).lte(new BN(newReserveAmount))) {
                                throw new Error('Update liquidity amount can only decrease the reserve token amount');
                            }

                            reserveTokenRecord.currentAmount = new BN(reserveTokenRecord.currentAmount)
                                .add(new BN(newReserveAmount))
                                .sub(new BN(prevReserveAmount))
                                .toString();
                            reserveTokenRecord.snapshots[timestamp] = reserveTokenRecord.currentAmount;

                            eventCount++;

                            break;
                        }

                        case 'ProtectionRemoved': {
                            const poolToken = returnValues._poolToken;
                            const reserveToken = returnValues._reserveToken;
                            const reserveAmount = returnValues._reserveAmount;

                            trace(
                                'Found ProtectionRemoved event at block',
                                arg('blockNumber', blockNumber),
                                arg('poolToken', poolToken),
                                arg('reserveToken', reserveToken),
                                arg('reserveAmount', reserveAmount),
                                arg('timestamp', timestamp),
                                arg('tx', transactionHash)
                            );

                            const poolTokenRecord = data.liquidity[poolToken];
                            const reserveTokenRecord = poolTokenRecord[reserveToken];

                            if (new BN(reserveTokenRecord.currentAmount).lt(new BN(reserveAmount))) {
                                throw new Error('Remove liquidity amount is too high for poolToken');
                            }

                            reserveTokenRecord.currentAmount = new BN(reserveTokenRecord.currentAmount)
                                .sub(new BN(reserveAmount))
                                .toString();
                            reserveTokenRecord.snapshots[timestamp] = reserveTokenRecord.currentAmount;

                            eventCount++;

                            break;
                        }
                    }
                }
            }

            info('Finished processing all new protection change events', arg('count', eventCount));
        };

        const getProtectedLiquidity = async (data, fromBlock, toBlock) => {
            if (!data.liquidity) {
                data.liquidity = {};
            }

            await getProtectionLiquidityChanges(data, fromBlock, toBlock);

            data.lastBlockNumber = toBlock;
        };

        const dbDir = path.resolve(__dirname, '../../data');
        await mkdirp(dbDir);
        const dbPath = path.resolve(dbDir, 'liquidity.json');
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

        const reorgOffset = 1000;
        const toBlock = (await web3.eth.getBlockNumber()) - reorgOffset;

        notice(
            'Getting protected liquidity from',
            arg('fromBlock', fromBlock),
            'to',
            arg('toBlock', toBlock),
            arg('reorgOffset', reorgOffset)
        );

        await getProtectedLiquidity(data, fromBlock, toBlock);

        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

        process.exit(0);
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
