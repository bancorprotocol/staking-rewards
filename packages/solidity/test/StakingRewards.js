const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');

const { ZERO_ADDRESS } = constants;
const { duration } = time;

const TestERC20Token = contract.fromArtifact('TestERC20Token');
const TestConverter = contract.fromArtifact('TestConverter');
const TestPoolToken = contract.fromArtifact('TestPoolToken');
const CheckpointStore = contract.fromArtifact('TestCheckpointStore');
const TokenGovernance = contract.fromArtifact('TestTokenGovernance');
const LiquidityProtection = contract.fromArtifact('TestLiquidityProtection');
const ContractRegistry = contract.fromArtifact('TestContractRegistry');
const StakingRewardsStore = contract.fromArtifact('TestStakingRewardsStore');
const StakingRewards = contract.fromArtifact('TestStakingRewards');

const LIQUIDITY_PROTECTION = web3.utils.asciiToHex('LiquidityProtection');

const ROLE_SUPERVISOR = web3.utils.keccak256('ROLE_SUPERVISOR');
const ROLE_REWARDS_DISTRIBUTOR = web3.utils.keccak256('ROLE_REWARDS_DISTRIBUTOR');
const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');
const ROLE_GOVERNOR = web3.utils.keccak256('ROLE_GOVERNOR');
const ROLE_MINTER = web3.utils.keccak256('ROLE_MINTER');

const PPM_RESOLUTION = new BN(1000000);
const MULTIPLIER_INCREMENT = PPM_RESOLUTION.div(new BN(4)); // 25%
const NETWORK_TOKEN_REWARDS_SHARE = new BN(700000); // 70%
const BASE_TOKEN_REWARDS_SHARE = new BN(300000); // 30%

const REWARD_RATE_FACTOR = new BN(10).pow(new BN(18));
const REWARDS_DURATION = duration.weeks(12);
const BIG_POOL_REWARD_RATE = new BN(200000)
    .div(new BN(2))
    .mul(new BN(10).pow(new BN(18)))
    .div(duration.weeks(1));
const SMALL_POOL_REWARD_RATE = new BN(20000)
    .div(new BN(2))
    .mul(new BN(10).pow(new BN(18)))
    .div(duration.weeks(1));

const getRewardsMultiplier = (stakingDuration) => {
    // For 0 <= x <= 1 weeks: 100% PPM
    if (stakingDuration.gte(duration.weeks(0)) && stakingDuration.lt(duration.weeks(1))) {
        return PPM_RESOLUTION;
    }

    // For 1 <= x <= 2 weeks: 125% PPM
    if (stakingDuration.gte(duration.weeks(1)) && stakingDuration.lt(duration.weeks(2))) {
        return PPM_RESOLUTION.add(MULTIPLIER_INCREMENT);
    }

    // For 2 <= x <= 3 weeks: 150% PPM
    if (stakingDuration.gte(duration.weeks(2)) && stakingDuration.lt(duration.weeks(3))) {
        return PPM_RESOLUTION.add(MULTIPLIER_INCREMENT.mul(new BN(2)));
    }

    // For 3 <= x < 4 weeks: 175% PPM
    if (stakingDuration.gte(duration.weeks(3)) && stakingDuration.lt(duration.weeks(4))) {
        return PPM_RESOLUTION.add(MULTIPLIER_INCREMENT.mul(new BN(3)));
    }

    // For x >= 4 weeks: 200% PPM
    return PPM_RESOLUTION.mul(new BN(2));
};

describe('StakingRewards', () => {
    let now;
    let prevNow;
    let contractRegistry;
    let reserveToken;
    let networkToken;
    let poolToken;
    let poolToken2;
    let checkpointStore;
    let networkTokenGovernance;
    let liquidityProtection;
    let store;
    let staking;

    const supervisor = defaultSender;

    const setTime = async (time) => {
        prevNow = now;
        now = time;

        for (const t of [checkpointStore, store, staking]) {
            if (t) {
                await t.setTime(now);
            }
        }
    };

    const getPoolRewards = async (poolToken, reserveToken) => {
        const data = await store.rewards.call(poolToken.address, reserveToken.address);

        return {
            lastUpdateTime: data[0],
            rewardPerToken: data[1],
            totalReserveAmount: data[2]
        };
    };

    const getProviderRewards = async (provider, poolToken, reserveToken) => {
        const data = await store.providerRewards.call(provider, poolToken.address, reserveToken.address);

        return {
            rewardPerToken: data[0],
            pendingBaseRewards: data[1],
            reserveAmount: data[2],
            effectiveStakingTime: data[3]
        };
    };

    beforeEach(async () => {
        contractRegistry = await ContractRegistry.new();

        networkToken = await TestERC20Token.new('TKN1', 'TKN1');
        reserveToken = await TestERC20Token.new('RSV1', 'RSV1');

        poolToken = await TestPoolToken.new('POOL1', 'POOL1');
        const converter = await TestConverter.new(poolToken.address, networkToken.address, reserveToken.address);
        await poolToken.setOwner(converter.address);

        poolToken2 = await TestPoolToken.new('POOL2', 'POOL2');
        const converter2 = await TestConverter.new(poolToken2.address, networkToken.address, reserveToken.address);
        await poolToken2.setOwner(converter2.address);

        networkTokenGovernance = await TokenGovernance.new(networkToken.address);
        await networkTokenGovernance.grantRole(ROLE_GOVERNOR, supervisor);
        await networkToken.transferOwnership(networkTokenGovernance.address);
        await networkTokenGovernance.acceptTokenOwnership();

        checkpointStore = await CheckpointStore.new();

        store = await StakingRewardsStore.new();
        staking = await StakingRewards.new(
            store.address,
            networkTokenGovernance.address,
            checkpointStore.address,
            contractRegistry.address
        );

        liquidityProtection = await LiquidityProtection.new(staking.address);
        await contractRegistry.registerAddress(LIQUIDITY_PROTECTION, liquidityProtection.address);

        await networkTokenGovernance.grantRole(ROLE_MINTER, staking.address);
        await store.grantRole(ROLE_OWNER, staking.address);

        await setTime(new BN(100000000));
    });

    describe('construction', async () => {
        it('should properly initialize roles', async () => {
            expect(await staking.getRoleMemberCount.call(ROLE_SUPERVISOR)).to.be.bignumber.equal(new BN(1));
            expect(await staking.getRoleMemberCount.call(ROLE_REWARDS_DISTRIBUTOR)).to.be.bignumber.equal(new BN(0));

            expect(await staking.getRoleAdmin.call(ROLE_SUPERVISOR)).to.eql(ROLE_SUPERVISOR);
            expect(await staking.getRoleAdmin.call(ROLE_REWARDS_DISTRIBUTOR)).to.eql(ROLE_SUPERVISOR);

            expect(await staking.hasRole.call(ROLE_SUPERVISOR, supervisor)).to.be.true();
            expect(await staking.hasRole.call(ROLE_REWARDS_DISTRIBUTOR, supervisor)).to.be.false();
        });

        it('should revert if initialized with a zero address store', async () => {
            await expectRevert(
                StakingRewards.new(
                    ZERO_ADDRESS,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    contractRegistry.address
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address network governance', async () => {
            await expectRevert(
                StakingRewards.new(store.address, ZERO_ADDRESS, checkpointStore.address, contractRegistry.address),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address checkpoint store', async () => {
            await expectRevert(
                StakingRewards.new(
                    store.address,
                    networkTokenGovernance.address,
                    ZERO_ADDRESS,
                    contractRegistry.address
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address registry', async () => {
            await expectRevert(
                StakingRewards.new(
                    store.address,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    ZERO_ADDRESS
                ),
                'ERR_INVALID_ADDRESS'
            );
        });
    });

    describe('notifications', async () => {
        const provider = accounts[1];
        const provider2 = accounts[2];
        const id = new BN(123);
        const liquidityProtectionProxy = accounts[3];
        const nonLiquidityProtection = accounts[9];

        beforeEach(async () => {
            await contractRegistry.registerAddress(LIQUIDITY_PROTECTION, liquidityProtectionProxy);

            await store.addPoolProgram(poolToken.address, now, now.add(REWARDS_DURATION), BIG_POOL_REWARD_RATE);
        });

        it('should revert when a non-LP contract attempts to notify', async () => {
            await expectRevert(
                staking.addLiquidity(provider, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: nonLiquidityProtection
                }),
                'ERR_ACCESS_DENIED'
            );

            await expectRevert(
                staking.removeLiquidity(provider, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: nonLiquidityProtection
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when notifying for a zero provider ', async () => {
            await expectRevert(
                staking.addLiquidity(ZERO_ADDRESS, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );

            await expectRevert(
                staking.removeLiquidity(ZERO_ADDRESS, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );
        });

        it('should revert when notifying for a non-whitelisted pool token', async () => {
            await expectRevert(
                staking.addLiquidity(provider, poolToken2.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_POOL_NOT_WHITELISTED'
            );

            await expectRevert(
                staking.removeLiquidity(provider, poolToken2.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_POOL_NOT_WHITELISTED'
            );
        });

        it('should revert when notifying for a zero reserve token ', async () => {
            await expectRevert(
                staking.addLiquidity(provider, poolToken.address, ZERO_ADDRESS, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );

            await expectRevert(
                staking.removeLiquidity(provider, poolToken.address, ZERO_ADDRESS, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );
        });

        it('should reflect on stored reserve amounts', async () => {
            // Check the initial state.
            let providerRewards1 = await getProviderRewards(provider, poolToken, reserveToken);
            let providerRewards2 = await getProviderRewards(provider2, poolToken, reserveToken);
            let poolRewards = await getPoolRewards(poolToken, reserveToken);
            expect(providerRewards1.reserveAmount).to.be.bignumber.equal(new BN(0));
            expect(providerRewards2.reserveAmount).to.be.bignumber.equal(new BN(0));
            expect(poolRewards.totalReserveAmount).to.be.bignumber.equal(new BN(0));

            // Add some liquidity for the first provider.
            const amount = new BN(1000);
            await staking.addLiquidity(provider, poolToken.address, reserveToken.address, 0, amount, id, {
                from: liquidityProtectionProxy
            });

            providerRewards1 = await getProviderRewards(provider, poolToken, reserveToken);
            providerRewards2 = await getProviderRewards(provider2, poolToken, reserveToken);
            poolRewards = await getPoolRewards(poolToken, reserveToken);
            expect(providerRewards1.reserveAmount).to.be.bignumber.equal(amount);
            expect(providerRewards2.reserveAmount).to.be.bignumber.equal(new BN(0));
            expect(poolRewards.totalReserveAmount).to.be.bignumber.equal(amount);

            // Add some liquidity for the second provider.
            const amount2 = new BN(12345);
            await staking.addLiquidity(provider2, poolToken.address, reserveToken.address, 0, amount2, id, {
                from: liquidityProtectionProxy
            });

            providerRewards1 = await getProviderRewards(provider, poolToken, reserveToken);
            providerRewards2 = await getProviderRewards(provider2, poolToken, reserveToken);
            poolRewards = await getPoolRewards(poolToken, reserveToken);
            expect(providerRewards1.reserveAmount).to.be.bignumber.equal(amount);
            expect(providerRewards2.reserveAmount).to.be.bignumber.equal(amount2);
            expect(poolRewards.totalReserveAmount).to.be.bignumber.equal(amount.add(amount2));

            // Remove some of first provider's liquidity.
            const removedAmount = new BN(5);
            await staking.removeLiquidity(provider, poolToken.address, reserveToken.address, 0, removedAmount, id, {
                from: liquidityProtectionProxy
            });

            providerRewards1 = await getProviderRewards(provider, poolToken, reserveToken);
            providerRewards2 = await getProviderRewards(provider2, poolToken, reserveToken);
            poolRewards = await getPoolRewards(poolToken, reserveToken);
            expect(providerRewards1.reserveAmount).to.be.bignumber.equal(amount.sub(removedAmount));
            expect(providerRewards2.reserveAmount).to.be.bignumber.equal(amount2);
            expect(poolRewards.totalReserveAmount).to.be.bignumber.equal(amount.sub(removedAmount).add(amount2));

            // Remove first provider's full liquidity.
            await staking.removeLiquidity(
                provider,
                poolToken.address,
                reserveToken.address,
                0,
                amount.sub(removedAmount),
                id,
                {
                    from: liquidityProtectionProxy
                }
            );

            providerRewards1 = await getProviderRewards(provider, poolToken, reserveToken);
            providerRewards2 = await getProviderRewards(provider2, poolToken, reserveToken);
            poolRewards = await getPoolRewards(poolToken, reserveToken);
            expect(providerRewards1.reserveAmount).to.be.bignumber.equal(new BN(0));
            expect(providerRewards2.reserveAmount).to.be.bignumber.equal(amount2);
            expect(poolRewards.totalReserveAmount).to.be.bignumber.equal(amount2);

            // Remove second provider's liquidity.
            await staking.removeLiquidity(provider2, poolToken.address, reserveToken.address, 0, amount2, id, {
                from: liquidityProtectionProxy
            });

            providerRewards1 = await getProviderRewards(provider, poolToken, reserveToken);
            providerRewards2 = await getProviderRewards(provider2, poolToken, reserveToken);
            poolRewards = await getPoolRewards(poolToken, reserveToken);
            expect(providerRewards1.reserveAmount).to.be.bignumber.equal(new BN(0));
            expect(providerRewards2.reserveAmount).to.be.bignumber.equal(new BN(0));
            expect(poolRewards.totalReserveAmount).to.be.bignumber.equal(new BN(0));
        });
    });

    describe('rewards', async () => {
        const providers = [accounts[1], accounts[2]];

        let reserveAmounts;
        let totalReserveAmounts;
        let programs;
        let providerPools;

        beforeEach(async () => {
            providerPools = {};
            reserveAmounts = {
                [poolToken.address]: {
                    [reserveToken.address]: {},
                    [networkToken.address]: {}
                },
                [poolToken2.address]: {
                    [reserveToken.address]: {},
                    [networkToken.address]: {}
                }
            };
            totalReserveAmounts = {
                [poolToken.address]: {
                    [reserveToken.address]: new BN(0),
                    [networkToken.address]: new BN(0)
                },
                [poolToken2.address]: {
                    [reserveToken.address]: new BN(0),
                    [networkToken.address]: new BN(0)
                }
            };
            programs = {
                [poolToken.address]: {},
                [poolToken2.address]: {}
            };

            for (const provider of providers) {
                providerPools[provider] = {
                    poolTokens: [],
                    reserveTokens: []
                };

                reserveAmounts[poolToken.address][reserveToken.address][provider] = new BN(0);
                reserveAmounts[poolToken.address][networkToken.address][provider] = new BN(0);
                reserveAmounts[poolToken2.address][reserveToken.address][provider] = new BN(0);
                reserveAmounts[poolToken2.address][networkToken.address][provider] = new BN(0);
            }
        });

        const addLiquidity = async (provider, poolToken, reserveToken, reserveAmount) => {
            if (!providerPools[provider].poolTokens.includes(poolToken.address)) {
                providerPools[provider].poolTokens.push(poolToken.address);
            }

            if (!providerPools[provider].reserveTokens.includes(reserveToken.address)) {
                providerPools[provider].reserveTokens.push(reserveToken.address);
            }

            reserveAmounts[poolToken.address][reserveToken.address][provider] = reserveAmounts[poolToken.address][
                reserveToken.address
            ][provider].add(reserveAmount);

            totalReserveAmounts[poolToken.address][reserveToken.address] = totalReserveAmounts[poolToken.address][
                reserveToken.address
            ].add(reserveAmount);

            await liquidityProtection.addLiquidity(provider, poolToken.address, reserveToken.address, reserveAmount, {
                from: provider
            });
        };

        const removeLiquidity = async (provider, poolToken, reserveToken, removedReserveAmount) => {
            expect(reserveAmounts[poolToken.address][reserveToken.address][provider]).to.be.bignumber.gte(
                removedReserveAmount
            );

            expect(totalReserveAmounts[poolToken.address][reserveToken.address]).to.be.bignumber.gte(
                removedReserveAmount
            );

            reserveAmounts[poolToken.address][reserveToken.address][provider] = reserveAmounts[poolToken.address][
                reserveToken.address
            ][provider].sub(removedReserveAmount);

            totalReserveAmounts[poolToken.address][reserveToken.address] = totalReserveAmounts[poolToken.address][
                reserveToken.address
            ].sub(removedReserveAmount);

            await liquidityProtection.removeLiquidity(
                provider,
                poolToken.address,
                reserveToken.address,
                removedReserveAmount,
                {
                    from: provider
                }
            );

            if (reserveAmounts[poolToken.address][reserveToken.address][provider].eq(new BN(0))) {
                providerPools[provider].reserveTokens.splice(
                    providerPools[provider].reserveTokens.indexOf(reserveToken.address),
                    1
                );

                if (providerPools[provider].reserveTokens.length === 0) {
                    providerPools[provider].poolTokens.splice(
                        providerPools[provider].poolTokens.indexOf(poolToken.address),
                        1
                    );
                }
            }
        };

        const addPoolProgram = async (poolToken, programStartTime, programEndTime, rewardRate) => {
            programs[poolToken.address] = {
                programStartTime,
                programEndTime,
                rewardRate
            };

            await store.addPoolProgram(poolToken.address, programStartTime, programEndTime, rewardRate);
        };

        const getExpectedRewards = (provider, duration, multiplierDuration = undefined) => {
            let reward = new BN(0);

            const { poolTokens, reserveTokens } = providerPools[provider];
            for (const poolToken of poolTokens) {
                for (const reserveToken of reserveTokens) {
                    const rewardShare =
                        reserveToken === networkToken.address ? NETWORK_TOKEN_REWARDS_SHARE : BASE_TOKEN_REWARDS_SHARE;

                    reward = reward.add(
                        reserveAmounts[poolToken][reserveToken][provider]
                            .mul(
                                duration
                                    .mul(programs[poolToken].rewardRate)
                                    .mul(REWARD_RATE_FACTOR)
                                    .mul(rewardShare)
                                    .div(PPM_RESOLUTION)
                                    .div(totalReserveAmounts[poolToken][reserveToken])
                            )
                            .div(REWARD_RATE_FACTOR)
                            .mul(getRewardsMultiplier(multiplierDuration || duration))
                            .div(PPM_RESOLUTION)
                    );
                }
            }

            return reward;
        };

        let programStartTime;
        let programEndTime;

        const testStatic = (providers) => {
            for (let i = 0; i < providers.length; ++i) {
                context(`provider #${i + 1}`, async () => {
                    const provider = providers[i];

                    it('should properly calculate all staking rewards', async () => {
                        // Should return no rewards before the program has started.
                        let reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(new BN(0));

                        // Should return no rewards immediately when the program has started.
                        await setTime(programStartTime);

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(new BN(0));

                        // Should return all rewards for the duration of one second.
                        await setTime(now.add(duration.seconds(1)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, duration.seconds(1)));

                        // Should return all rewards for a single day.
                        await setTime(programStartTime.add(duration.days(1)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, duration.days(1)));

                        // Should return all weekly rewards + second week's retroactive multiplier.
                        await setTime(programStartTime.add(duration.weeks(1)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, duration.weeks(1)));

                        // Should return all program rewards + max retroactive multipliers.
                        await setTime(programEndTime);

                        reward = await staking.rewards.call({ from: provider });
                        const programDuration = programEndTime.sub(programStartTime);
                        expect(reward).to.be.bignumber.equal(
                            getExpectedRewards(provider, programDuration, duration.weeks(4))
                        );

                        // Should not affect rewards after the ending time of the program.
                        await setTime(programEndTime.add(duration.days(1)));

                        const reward2 = await staking.rewards.call({ from: provider });
                        expect(reward2).to.be.bignumber.equal(reward);
                    });

                    it('should claim all staking rewards', async () => {
                        // Should return no rewards before the program has started.
                        let reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(new BN(0));

                        let prevBalance = await networkToken.balanceOf.call(provider);
                        await staking.claimRewards({ from: provider });
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance);

                        // Should return no rewards immediately when the program has started.
                        await setTime(programStartTime);

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(new BN(0));

                        prevBalance = await networkToken.balanceOf.call(provider);
                        await staking.claimRewards({ from: provider });
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance);

                        // Should grant all rewards for the duration of one second.
                        await setTime(now.add(duration.seconds(1)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, now.sub(prevNow)));

                        prevBalance = await networkToken.balanceOf.call(provider);
                        await staking.claimRewards({ from: provider });
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                            prevBalance.add(reward)
                        );
                        expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                        // Should return all rewards for a single day, excluding previously granted rewards.
                        await setTime(programStartTime.add(duration.days(1)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, now.sub(prevNow)));

                        prevBalance = await networkToken.balanceOf.call(provider);
                        await staking.claimRewards({ from: provider });
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                            prevBalance.add(reward)
                        );
                        expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                        // Should return all weekly rewards, excluding previously granted rewards, but without the
                        // multiplier bonus.
                        await setTime(programStartTime.add(duration.weeks(1)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, now.sub(prevNow)));

                        prevBalance = await networkToken.balanceOf.call(provider);
                        await staking.claimRewards({ from: provider });
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                            prevBalance.add(reward)
                        );
                        expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                        // Should return all the rewards for the two weeks, excluding previously granted rewards, with the
                        // two weeks rewards multiplier.
                        await setTime(programStartTime.add(duration.weeks(3)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(
                            getExpectedRewards(provider, now.sub(prevNow), duration.weeks(2))
                        );

                        prevBalance = await networkToken.balanceOf.call(provider);
                        await staking.claimRewards({ from: provider });
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                            prevBalance.add(reward)
                        );
                        expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                        // Should return all program rewards, excluding previously granted rewards + max retroactive
                        // multipliers.
                        await setTime(programEndTime);

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(
                            getExpectedRewards(provider, now.sub(prevNow), duration.weeks(4))
                        );

                        prevBalance = await networkToken.balanceOf.call(provider);
                        await staking.claimRewards({ from: provider });
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                            prevBalance.add(reward)
                        );
                        expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                        // Should return no additional rewards after the ending time of the program.
                        await setTime(programEndTime.add(duration.days(1)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(new BN(0));
                    });
                });
            }
        };

        const testDynamic = (providers) => {
            for (let i = 0; i < providers.length; ++i) {
                context(`provider ${i + 1}`, async () => {
                    const provider = providers[i];

                    it('should claim all staking rewards when removing liquidity', async () => {
                        // Should return all rewards for three weeks, with the three weeks multiplier bonus
                        await setTime(programStartTime.add(duration.weeks(3)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, duration.weeks(3)));

                        const removedAmount = new BN(100);
                        prevBalance = await networkToken.balanceOf.call(provider);
                        await removeLiquidity(provider, poolToken, reserveToken, removedAmount);
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                            prevBalance.add(reward)
                        );
                        expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                        // Re-add the removed liquidity.
                        await addLiquidity(provider, poolToken, reserveToken, removedAmount);

                        // Should return all rewards for two weeks + second week's retroactive multiplier.
                        await setTime(now.add(duration.weeks(2)));

                        reward = await staking.rewards.call({ from: provider });
                        expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, duration.weeks(2)));

                        const removedAllAmount = reserveAmounts[poolToken.address][networkToken.address][provider];
                        prevBalance = await networkToken.balanceOf.call(provider);
                        await removeLiquidity(provider, poolToken, networkToken, removedAllAmount);
                        expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                            prevBalance.add(reward)
                        );
                        expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));
                    });
                });
            }
        };

        context('single pool', async () => {
            beforeEach(async () => {
                await setTime(now);

                programStartTime = now.add(duration.weeks(1));
                programEndTime = programStartTime.add(REWARDS_DURATION);

                await addPoolProgram(poolToken, programStartTime, programEndTime, BIG_POOL_REWARD_RATE);

                await addLiquidity(providers[0], poolToken, reserveToken, new BN(1000).mul(new BN(10).pow(new BN(18))));
            });

            context('single sided staking', async () => {
                context('single provider', async () => {
                    testStatic([providers[0]]);
                    testDynamic([providers[0]]);
                });

                context('multiple providers', async () => {
                    beforeEach(async () => {
                        await addLiquidity(
                            providers[1],
                            poolToken,
                            reserveToken,
                            new BN(222222).mul(new BN(10).pow(new BN(18)))
                        );
                    });

                    testStatic(providers);
                    testDynamic(providers);
                });
            });

            context('double sided staking', async () => {
                beforeEach(async () => {
                    await addLiquidity(
                        providers[0],
                        poolToken,
                        networkToken,
                        new BN(999999999).mul(new BN(10).pow(new BN(18)))
                    );
                });

                context('single provider', async () => {
                    testStatic([providers[0]]);
                    testDynamic([providers[0]]);
                });

                context('multiple providers', async () => {
                    beforeEach(async () => {
                        await addLiquidity(
                            providers[1],
                            poolToken,
                            reserveToken,
                            new BN(222222).mul(new BN(10).pow(new BN(18)))
                        );
                        await addLiquidity(
                            providers[1],
                            poolToken,
                            networkToken,
                            new BN(1100093).mul(new BN(10).pow(new BN(18)))
                        );
                    });

                    testStatic(providers);
                    testDynamic(providers);
                });
            });
        });

        context('multiple pools', async () => {
            beforeEach(async () => {
                await setTime(now);

                programStartTime = now.add(duration.weeks(1));
                programEndTime = programStartTime.add(REWARDS_DURATION);

                await addPoolProgram(poolToken, programStartTime, programEndTime, BIG_POOL_REWARD_RATE);
                await addPoolProgram(poolToken2, programStartTime, programEndTime, SMALL_POOL_REWARD_RATE);

                await addLiquidity(
                    providers[0],
                    poolToken,
                    reserveToken,
                    new BN(65564).mul(new BN(10).pow(new BN(18)))
                );
                await addLiquidity(
                    providers[0],
                    poolToken2,
                    reserveToken,
                    new BN(11111111111).mul(new BN(10).pow(new BN(18)))
                );
            });

            context('single sided staking', async () => {
                context('single provider', async () => {
                    testStatic([providers[0]]);
                    testDynamic([providers[0]]);
                });

                context('multiple providers', async () => {
                    beforeEach(async () => {
                        await addLiquidity(
                            providers[1],
                            poolToken,
                            reserveToken,
                            new BN(66666).mul(new BN(10).pow(new BN(18)))
                        );
                        await addLiquidity(
                            providers[1],
                            poolToken2,
                            reserveToken,
                            new BN(88888888).mul(new BN(10).pow(new BN(18)))
                        );
                    });

                    testStatic(providers);
                    testDynamic(providers);
                });
            });

            context('double sided staking', async () => {
                beforeEach(async () => {
                    await addLiquidity(
                        providers[0],
                        poolToken,
                        networkToken,
                        new BN(999999999).mul(new BN(10).pow(new BN(18)))
                    );
                    await addLiquidity(
                        providers[0],
                        poolToken2,
                        networkToken,
                        new BN('324832904093249203').mul(new BN(10).pow(new BN(18)))
                    );
                });

                context('single provider', async () => {
                    testStatic([providers[0]]);
                    testDynamic([providers[0]]);
                });

                context('multiple providers', async () => {
                    beforeEach(async () => {
                        await addLiquidity(
                            providers[1],
                            poolToken,
                            reserveToken,
                            new BN(2342323432).mul(new BN(10).pow(new BN(18)))
                        );
                        await addLiquidity(
                            providers[1],
                            poolToken2,
                            reserveToken,
                            new BN(322222222222).mul(new BN(10).pow(new BN(18)))
                        );

                        await addLiquidity(
                            providers[1],
                            poolToken,
                            networkToken,
                            new BN(777770000001).mul(new BN(10).pow(new BN(18)))
                        );
                        await addLiquidity(
                            providers[1],
                            poolToken2,
                            networkToken,
                            new BN('234324234234234243223999').mul(new BN(10).pow(new BN(18)))
                        );
                    });

                    testStatic(providers);
                    testDynamic(providers);
                });
            });
        });
    });
});
