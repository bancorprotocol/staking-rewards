const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN, time } = require('@openzeppelin/test-helpers');
const Decimal = require('decimal.js');
const { expect } = require('../chai-local');

const { ZERO_ADDRESS } = constants;
const { duration } = time;

const TestERC20Token = contract.fromArtifact('TestERC20Token');
const TestConverter = contract.fromArtifact('TestConverter');
const TestPoolToken = contract.fromArtifact('TestPoolToken');
const CheckpointStore = contract.fromArtifact('TestCheckpointStore');
const TokenGovernance = contract.fromArtifact('TestTokenGovernance');
const LiquidityProtection = contract.fromArtifact('TestLiquidityProtection');
const LiquidityProtectionDataStore = contract.fromArtifact('TestLiquidityProtectionDataStore');

const ContractRegistry = contract.fromArtifact('TestContractRegistry');
const StakingRewardsStore = contract.fromArtifact('TestStakingRewardsStore');
const StakingRewards = contract.fromArtifact('TestStakingRewards');

const LIQUIDITY_PROTECTION = web3.utils.asciiToHex('LiquidityProtection');

const ROLE_SUPERVISOR = web3.utils.keccak256('ROLE_SUPERVISOR');
const ROLE_REWARDS_DISTRIBUTOR = web3.utils.keccak256('ROLE_REWARDS_DISTRIBUTOR');
const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');
const ROLE_GOVERNOR = web3.utils.keccak256('ROLE_GOVERNOR');
const ROLE_MINTER = web3.utils.keccak256('ROLE_MINTER');
const ROLE_PUBLISHER = web3.utils.keccak256('ROLE_PUBLISHER');

const PPM_RESOLUTION = new BN(1000000);
const MULTIPLIER_INCREMENT = PPM_RESOLUTION.div(new BN(4)); // 25%
const NETWORK_TOKEN_REWARDS_SHARE = new BN(700000); // 70%
const BASE_TOKEN_REWARDS_SHARE = new BN(300000); // 30%

const REWARD_RATE_FACTOR = new BN(10).pow(new BN(18));
const REWARDS_DURATION = duration.weeks(12);
const BIG_POOL_BASE_REWARD_RATE = new BN(100000).mul(new BN(10).pow(new BN(18))).div(duration.weeks(1));
const SMALL_POOL_BASE_REWARD_RATE = new BN(10000).mul(new BN(10).pow(new BN(18))).div(duration.weeks(1));

describe('StakingRewards', () => {
    let now;
    let prevNow;
    let contractRegistry;
    let reserveToken;
    let networkToken;
    let poolToken;
    let poolToken2;
    let poolToken3;
    let checkpointStore;
    let networkTokenGovernance;
    let liquidityProtectionStore;
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

    const getPoolRewards = async (poolToken, reserveToken) => {
        const data = await store.rewards.call(poolToken.address || poolToken, reserveToken.address || reserveToken);

        return {
            lastUpdateTime: data[0],
            rewardPerToken: data[1],
            totalClaimedRewards: data[2]
        };
    };

    const printPoolRewards = async (poolToken, reserveToken) => {
        const data = await getPoolRewards(poolToken, reserveToken);

        console.log();

        console.log('lastUpdateTime', data.lastUpdateTime.toString());
        console.log('rewardPerToken', data.rewardPerToken.toString());
        console.log('totalClaimedRewards', data.totalClaimedRewards.toString());

        const totalProtectedReserveAmount = await liquidityProtectionStore.totalProtectedReserveAmount.call(
            poolToken.address || poolToken,
            reserveToken.address || reserveToken
        );
        console.log('totalProtectedReserveAmount', totalProtectedReserveAmount.toString());

        console.log();
    };

    const getProviderRewards = async (provider, poolToken, reserveToken) => {
        const data = await store.providerRewards.call(
            provider,
            poolToken.address || poolToken,
            reserveToken.address || reserveToken
        );

        return {
            rewardPerToken: data[0],
            pendingBaseRewards: data[1],
            totalClaimedRewards: data[2],
            effectiveStakingTime: data[3],
            baseRewardsDebt: data[4],
            baseRewardsDebtMultiplier: data[5]
        };
    };

    const printProviderRewards = async (provider, poolToken, reserveToken) => {
        const data = await getProviderRewards(provider, poolToken, reserveToken);

        console.log();

        console.log('rewardPerToken', data.rewardPerToken.toString());
        console.log('pendingBaseRewards', data.pendingBaseRewards.toString());
        console.log('totalClaimedRewards', data.totalClaimedRewards.toString());
        console.log('effectiveStakingTime', data.effectiveStakingTime.toString());
        console.log('baseRewardsDebt', data.baseRewardsDebt.toString());
        console.log('baseRewardsDebtMultiplier', data.baseRewardsDebtMultiplier.toString());

        const providerReserveAmount = await liquidityProtectionStore.providerReserveAmount.call(
            provider,
            poolToken.address || poolToken,
            reserveToken.address || reserveToken
        );
        console.log('providerReserveAmount', providerReserveAmount.toString());

        console.log();
    };

    const expectAlmostEqual = (amount1, amount2, maxError = 0.0000000001) => {
        if (!amount1.eq(amount2)) {
            const error = Decimal(amount1.toString()).div(amount2.toString()).sub(1).abs();
            expect(error.lte(maxError)).to.be.true(`error = ${error.toFixed(maxError.length)}`);
        }
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

        poolToken3 = await TestPoolToken.new('POOL3', 'POOL3');
        const converter3 = await TestConverter.new(poolToken3.address, networkToken.address, reserveToken.address);
        await poolToken3.setOwner(converter3.address);

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

        liquidityProtectionStore = await LiquidityProtectionDataStore.new(store.address);
        liquidityProtection = await LiquidityProtection.new(liquidityProtectionStore.address, staking.address);
        await contractRegistry.registerAddress(LIQUIDITY_PROTECTION, liquidityProtection.address);

        await store.grantRole(ROLE_OWNER, staking.address);
        await staking.grantRole(ROLE_PUBLISHER, liquidityProtection.address);
        await networkTokenGovernance.grantRole(ROLE_MINTER, staking.address);

        await setTime(new BN(100000000));
    });

    describe('construction', async () => {
        it('should properly initialize roles', async () => {
            const newStaking = await StakingRewards.new(
                store.address,
                networkTokenGovernance.address,
                checkpointStore.address,
                contractRegistry.address
            );

            expect(await newStaking.getRoleMemberCount.call(ROLE_SUPERVISOR)).to.be.bignumber.equal(new BN(1));
            expect(await newStaking.getRoleMemberCount.call(ROLE_PUBLISHER)).to.be.bignumber.equal(new BN(0));
            expect(await newStaking.getRoleMemberCount.call(ROLE_REWARDS_DISTRIBUTOR)).to.be.bignumber.equal(new BN(0));

            expect(await newStaking.getRoleAdmin.call(ROLE_SUPERVISOR)).to.eql(ROLE_SUPERVISOR);
            expect(await newStaking.getRoleAdmin.call(ROLE_PUBLISHER)).to.eql(ROLE_SUPERVISOR);
            expect(await newStaking.getRoleAdmin.call(ROLE_REWARDS_DISTRIBUTOR)).to.eql(ROLE_SUPERVISOR);

            expect(await newStaking.hasRole.call(ROLE_SUPERVISOR, supervisor)).to.be.true();
            expect(await newStaking.hasRole.call(ROLE_PUBLISHER, supervisor)).to.be.false();
            expect(await newStaking.hasRole.call(ROLE_REWARDS_DISTRIBUTOR, supervisor)).to.be.false();
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
        const id = new BN(123);
        const liquidityProtectionProxy = accounts[3];
        const nonLiquidityProtection = accounts[9];

        beforeEach(async () => {
            await setTime(now.add(duration.weeks(1)));

            await staking.grantRole(ROLE_PUBLISHER, liquidityProtectionProxy);

            await store.addPoolProgram(
                poolToken.address,
                [networkToken.address, reserveToken.address],
                [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                now.add(REWARDS_DURATION),
                BIG_POOL_BASE_REWARD_RATE
            );
        });

        it('should revert when a non-LP contract attempts to notify', async () => {
            await expectRevert(
                staking.onLiquidityAdded(id, provider, poolToken.address, reserveToken.address, 0, 0, {
                    from: nonLiquidityProtection
                }),
                'ERR_ACCESS_DENIED'
            );

            await expectRevert(
                staking.onLiquidityRemoved(id, provider, poolToken.address, reserveToken.address, 0, 0, {
                    from: nonLiquidityProtection
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when notifying for a zero provider ', async () => {
            await expectRevert(
                staking.onLiquidityAdded(id, ZERO_ADDRESS, poolToken.address, reserveToken.address, 0, 0, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );

            await expectRevert(
                staking.onLiquidityRemoved(id, ZERO_ADDRESS, poolToken.address, reserveToken.address, 0, 0, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );
        });
    });

    describe('rewards', async () => {
        const providers = [accounts[1], accounts[2]];

        let reserveAmounts;
        let totalReserveAmounts;
        let programs;
        let providerPools;

        beforeEach(async () => {
            const poolTokens = [poolToken, poolToken2, poolToken3];

            reserveAmounts = {};
            totalReserveAmounts = {};
            programs = {};
            providerPools = {};

            for (const { address: poolToken } of poolTokens) {
                reserveAmounts[poolToken] = {
                    [reserveToken.address]: {},
                    [networkToken.address]: {}
                };

                totalReserveAmounts[poolToken] = {
                    [reserveToken.address]: new BN(0),
                    [networkToken.address]: new BN(0)
                };

                programs[poolToken] = {
                    [reserveToken.address]: new BN(0),
                    [networkToken.address]: new BN(0)
                };

                for (const provider of accounts) {
                    providerPools[provider] = {};

                    reserveAmounts[poolToken][reserveToken.address][provider] = new BN(0);
                    reserveAmounts[poolToken][networkToken.address][provider] = new BN(0);
                }
            }
        });

        const addTestLiquidity = async (provider, poolToken, reserveToken, reserveAmount) => {
            if (!providerPools[provider][poolToken.address]) {
                providerPools[provider][poolToken.address] = [];
            }

            const reserveTokens = providerPools[provider][poolToken.address];
            if (!reserveTokens.includes(reserveToken.address)) {
                reserveTokens.push(reserveToken.address);
            }

            reserveAmounts[poolToken.address][reserveToken.address][provider] = reserveAmounts[poolToken.address][
                reserveToken.address
            ][provider].add(reserveAmount);

            totalReserveAmounts[poolToken.address][reserveToken.address] = totalReserveAmounts[poolToken.address][
                reserveToken.address
            ].add(reserveAmount);
        };

        const addLiquidity = async (provider, poolToken, reserveToken, reserveAmount) => {
            addTestLiquidity(provider, poolToken, reserveToken, reserveAmount);

            await liquidityProtection.addLiquidity(provider, poolToken.address, reserveToken.address, reserveAmount, {
                from: provider
            });
        };

        const removeTestLiquidity = async (provider, poolToken, reserveToken, removedReserveAmount) => {
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

            if (reserveAmounts[poolToken.address][reserveToken.address][provider].eq(new BN(0))) {
                providerPools[provider][poolToken.address].splice(
                    providerPools[provider][poolToken.address].indexOf(reserveToken.address),
                    1
                );

                let reserveToken2;
                if (providerPools[provider][poolToken.address].length > 0) {
                    reserveToken2 = providerPools[provider][poolToken.address][0];
                }

                if (
                    !reserveToken2 ||
                    reserveAmounts[poolToken.address][reserveToken2.address][provider].eq(new BN(0))
                ) {
                    providerPools[provider].poolTokens = [];
                }
            }
        };

        const removeLiquidity = async (provider, poolToken, reserveToken, removedReserveAmount) => {
            await liquidityProtection.removeLiquidity(
                provider,
                poolToken.address,
                reserveToken.address,
                removedReserveAmount,
                {
                    from: provider
                }
            );

            removeTestLiquidity(provider, poolToken, reserveToken, removedReserveAmount);
        };

        const addPoolProgram = async (poolToken, programEndTime, rewardRate) => {
            programs[poolToken.address] = {
                now,
                programEndTime,
                rewardRate
            };

            await store.addPoolProgram(
                poolToken.address,
                [networkToken.address, reserveToken.address],
                [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                programEndTime,
                rewardRate
            );
        };

        const getExpectedRewards = (provider, duration, multiplierDuration = undefined) => {
            let reward = new BN(0);
            if (duration.lte(new BN(0))) {
                return reward;
            }

            for (const [poolToken, reserveTokens] of Object.entries(providerPools[provider])) {
                for (const reserveToken of reserveTokens) {
                    const rewardShare =
                        reserveToken === networkToken.address ? NETWORK_TOKEN_REWARDS_SHARE : BASE_TOKEN_REWARDS_SHARE;

                    const currentReward = reserveAmounts[poolToken][reserveToken][provider]
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
                        .div(PPM_RESOLUTION);

                    reward = reward.add(currentReward);
                }
            }

            return reward;
        };

        let programStartTime;
        let programEndTime;

        const testRewards = async (provider, multiplierDuration = undefined) => {
            const reward = await staking.rewards.call(provider);

            const effectiveTime = BN.min(now, programEndTime);
            const expectedReward = getExpectedRewards(
                provider,
                effectiveTime.sub(programStartTime),
                multiplierDuration
            );

            expect(reward).to.be.bignumber.equal(expectedReward);

            const totalProviderClaimedRewards = await staking.totalClaimedRewards.call(provider);
            expect(totalProviderClaimedRewards).to.be.bignumber.equal(new BN(0));
        };

        const testPartialRewards = async (provider, prevReward, multiplierDuration = undefined) => {
            const reward = await staking.rewards.call(provider);

            const effectiveTime = BN.min(now, programEndTime);
            const extraReward = getExpectedRewards(provider, effectiveTime.sub(prevNow), multiplierDuration);
            const multiplier = getRewardsMultiplier(multiplierDuration || effectiveTime.sub(programStartTime));

            expectAlmostEqual(prevReward.mul(multiplier).div(PPM_RESOLUTION).add(extraReward), reward);

            const totalProviderClaimedRewards = await staking.totalClaimedRewards.call(provider);
            expect(totalProviderClaimedRewards).to.be.bignumber.equal(new BN(0));
        };

        const testClaim = async (provider, multiplierDuration = undefined) => {
            const reward = await staking.rewards.call(provider);

            const effectiveTime = BN.min(now, programEndTime);
            const expectedReward = getExpectedRewards(provider, effectiveTime.sub(prevNow), multiplierDuration);

            expect(reward).to.be.bignumber.equal(expectedReward);

            const claimed = await staking.claimRewards.call({ from: provider });
            expect(claimed).to.be.bignumber.equal(reward);

            const prevBalance = await networkToken.balanceOf.call(provider);
            const prevTotalProviderClaimed = await staking.totalClaimedRewards.call(provider);

            const tx = await staking.claimRewards({ from: provider });
            if (claimed.gt(new BN(0))) {
                expectEvent(tx, 'RewardsClaimed', {
                    provider,
                    amount: claimed
                });
            }

            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
            expect(await staking.totalClaimedRewards.call(provider)).to.be.bignumber.equal(
                prevTotalProviderClaimed.add(reward)
            );

            expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));
        };

        const testUpdateRewards = async (providers) => {
            const pendingRewards = {};
            const baseRewards = {};

            for (const provider of providers) {
                pendingRewards[provider] = {};
                baseRewards[provider] = {};

                for (const [poolToken, reserveTokens] of Object.entries(providerPools[provider])) {
                    pendingRewards[provider][poolToken] = {};
                    baseRewards[provider][poolToken] = {};

                    for (const reserveToken of reserveTokens) {
                        const providerRewards = await getProviderRewards(provider, poolToken, reserveToken);

                        pendingRewards[provider][poolToken][reserveToken] = providerRewards.pendingBaseRewards;
                        baseRewards[provider][poolToken][reserveToken] = await staking.baseRewards.call(
                            provider,
                            poolToken,
                            reserveToken
                        );
                    }
                }
            }

            await staking.updateRewards(providers);

            for (const provider of providers) {
                for (const [poolToken, reserveTokens] of Object.entries(providerPools[provider])) {
                    for (const reserveToken of reserveTokens) {
                        const providerRewards = await getProviderRewards(provider, poolToken, reserveToken);

                        expect(providerRewards.pendingBaseRewards).to.bignumber.equal(
                            pendingRewards[provider][poolToken][reserveToken].add(
                                baseRewards[provider][poolToken][reserveToken]
                            )
                        );

                        expect(await staking.baseRewards.call(provider, poolToken, reserveToken)).to.be.bignumber.equal(
                            new BN(0)
                        );
                    }
                }
            }
        };

        const testStaking = async (provider, amount, newPoolToken, participating = false) => {
            const reward = await staking.rewards.call(provider);

            const data = await staking.stakeRewards.call(amount, newPoolToken.address, { from: provider });
            expect(data[0]).to.be.bignumber.equal(amount);

            const prevProviderBalance = await networkToken.balanceOf.call(provider);
            const prevTotalProviderClaimed = await staking.totalClaimedRewards.call(provider);
            const pervLiquidityProtectionBalance = await networkToken.balanceOf.call(liquidityProtection.address);

            const tx = await staking.stakeRewards(amount, newPoolToken.address, { from: provider });
            expectEvent(tx, 'RewardsStaked', {
                provider,
                poolToken: newPoolToken.address,
                amount,
                newId: data[1]
            });

            // If we're staking to a participating pool, don't forget to update the local liquidity state for staking.
            if (participating) {
                addTestLiquidity(provider, newPoolToken, networkToken, amount);
            }

            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevProviderBalance);
            expect(await staking.totalClaimedRewards.call(provider)).to.be.bignumber.equal(
                prevTotalProviderClaimed.add(data[0])
            );
            expect(await networkToken.balanceOf.call(liquidityProtection.address)).to.be.bignumber.equal(
                pervLiquidityProtectionBalance.add(amount)
            );

            expect(await liquidityProtection.provider.call()).to.eql(provider);
            expect(await liquidityProtection.poolToken.call()).to.eql(newPoolToken.address);
            expect(await liquidityProtection.reserveToken.call()).to.eql(networkToken.address);
            expect(await liquidityProtection.reserveAmount.call()).to.be.bignumber.equal(amount);

            const newReward = await staking.rewards.call(provider);

            // take into account that there there might be very small imprecisions when dealing with
            // multipliers
            if (newReward.eq(new BN(0))) {
                expect(newReward).to.be.bignumber.closeTo(reward.sub(amount), new BN(1));
            } else {
                expectAlmostEqual(newReward, reward.sub(amount));
            }

            return newReward;
        };

        const tests = (providers) => {
            for (let i = 0; i < providers.length; ++i) {
                context(`provider #${i + 1}`, async () => {
                    const provider = providers[i];

                    describe('querying', async () => {
                        it('should properly calculate all rewards', async () => {
                            // Should return all rewards for the duration of one second.
                            await setTime(now.add(duration.seconds(1)));
                            await testRewards(provider);

                            // Should return all rewards for a single day.
                            await setTime(programStartTime.add(duration.days(1)));
                            await testRewards(provider);

                            // Should return all weekly rewards + second week's retroactive multiplier.
                            await setTime(programStartTime.add(duration.weeks(1)));
                            await testRewards(provider);

                            // Should return all program rewards + max retroactive multipliers.
                            await setTime(programEndTime);
                            await testRewards(provider, duration.weeks(4));

                            // Should not affect rewards after the ending time of the program.
                            await setTime(programEndTime.add(duration.days(1)));
                            await testRewards(provider, duration.weeks(4));
                        });

                        it('should not affect the rewards, when adding liquidity in the same block', async () => {
                            const provider3 = accounts[3];

                            await setTime(programStartTime.add(duration.weeks(5)));

                            const reward = await staking.rewards.call(provider);

                            await addLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(1).mul(new BN(10).pow(new BN(18)))
                            );

                            expectAlmostEqual(await staking.rewards.call(provider), reward);

                            await addLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(11111).mul(new BN(10).pow(new BN(18)))
                            );

                            await addLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(1000000).mul(new BN(10).pow(new BN(18)))
                            );

                            expectAlmostEqual(await staking.rewards.call(provider), reward);

                            await addLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(11111).mul(new BN(10).pow(new BN(18)))
                            );

                            await addLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(1).mul(new BN(10).pow(new BN(18)))
                            );

                            await addLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(234324234234).mul(new BN(10).pow(new BN(18)))
                            );

                            expectAlmostEqual(await staking.rewards.call(provider), reward);
                        });

                        it('should not affect the rewards, when removing liquidity in the same block', async () => {
                            const provider3 = accounts[3];

                            await addLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(1000000).mul(new BN(10).pow(new BN(18)))
                            );

                            await setTime(programStartTime.add(duration.weeks(5)));

                            const reward = await staking.rewards.call(provider);

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(1).mul(new BN(10).pow(new BN(18)))
                            );

                            await removeLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(1).mul(new BN(10).pow(new BN(18)))
                            );

                            expectAlmostEqual(await staking.rewards.call(provider), reward);

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(11111).mul(new BN(10).pow(new BN(18)))
                            );

                            await removeLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(11111).mul(new BN(10).pow(new BN(18)))
                            );

                            expectAlmostEqual(await staking.rewards.call(provider), reward);

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(11111).mul(new BN(10).pow(new BN(18)))
                            );

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(1000).mul(new BN(10).pow(new BN(18)))
                            );

                            await removeLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(50000).mul(new BN(10).pow(new BN(18)))
                            );

                            expectAlmostEqual(await staking.rewards.call(provider), reward);
                        });

                        it('should properly calculate all rewards when adding liquidity', async () => {
                            const provider3 = accounts[3];

                            let prevReward = await staking.rewards.call(provider);

                            await addLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(1000).mul(new BN(10).pow(new BN(18)))
                            );

                            await setTime(now.add(duration.days(1)));
                            await testPartialRewards(provider, prevReward);

                            prevReward = await staking.rewards.call(provider);

                            await addLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(28238238).mul(new BN(10).pow(new BN(18)))
                            );

                            await addLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(50000).mul(new BN(10).pow(new BN(18)))
                            );

                            await setTime(now.add(duration.days(1)));
                            await testPartialRewards(provider, prevReward);

                            prevReward = await staking.rewards.call(provider);

                            await addLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(990930923).mul(new BN(10).pow(new BN(18)))
                            );

                            await addLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(2666678).mul(new BN(10).pow(new BN(18)))
                            );

                            await setTime(now.add(duration.weeks(2)));
                            await testPartialRewards(provider, prevReward, duration.weeks(2));
                        });

                        it('should properly calculate all rewards when removing liquidity', async () => {
                            const provider3 = accounts[3];

                            await addLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(1000000).mul(new BN(10).pow(new BN(18)))
                            );

                            let prevReward = await staking.rewards.call(provider);

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(1).mul(new BN(10).pow(new BN(18)))
                            );

                            await removeLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(1).mul(new BN(10).pow(new BN(18)))
                            );

                            // Should return all rewards for the duration of one second.
                            await setTime(now.add(duration.seconds(1)));
                            await testPartialRewards(provider, prevReward);

                            prevReward = await staking.rewards.call(provider);

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(50000).mul(new BN(10).pow(new BN(18)))
                            );

                            await removeLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(50000).mul(new BN(10).pow(new BN(18)))
                            );

                            await setTime(now.add(duration.days(1)));
                            await testPartialRewards(provider, prevReward);

                            prevReward = await staking.rewards.call(provider);

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(10000).mul(new BN(10).pow(new BN(18)))
                            );

                            await setTime(now.add(duration.days(1)));
                            await testPartialRewards(provider, prevReward);

                            prevReward = await staking.rewards.call(provider);

                            await removeLiquidity(
                                provider,
                                poolToken,
                                reserveToken,
                                new BN(30000).mul(new BN(10).pow(new BN(18)))
                            );

                            await removeLiquidity(
                                provider3,
                                poolToken,
                                reserveToken,
                                new BN(25000).mul(new BN(10).pow(new BN(18)))
                            );

                            await setTime(now.add(duration.weeks(3)));
                            await testPartialRewards(provider, prevReward, duration.weeks(3));
                        });

                        it('should keep all rewards when removing liquidity', async () => {
                            // Should return all rewards for four weeks, with the four weeks multiplier bonus
                            await setTime(programStartTime.add(duration.weeks(1)));

                            const unclaimed = await staking.rewards.call(provider);
                            expect(unclaimed).to.be.bignumber.equal(getExpectedRewards(provider, duration.weeks(1)));
                            const debMultiplier = getRewardsMultiplier(duration.weeks(1));
                            const debt = unclaimed.mul(PPM_RESOLUTION).div(debMultiplier);

                            // Remove all the liquidity.
                            const fullAmount = reserveAmounts[poolToken.address][reserveToken.address][provider];
                            const prevBalance = await networkToken.balanceOf.call(provider);
                            await removeLiquidity(provider, poolToken, reserveToken, fullAmount);
                            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance);

                            // Should not affect the claimable amount.
                            let reward = await staking.rewards.call(provider);

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, debt.mul(debMultiplier).div(PPM_RESOLUTION));

                            await setTime(now.add(duration.weeks(1)));

                            // Should retroactively apply the two weeks multiplier on the debt rewards.
                            const multiplier2 = getRewardsMultiplier(duration.weeks(1));
                            let bestMultiplier = BN.max(debMultiplier, multiplier2);
                            reward = await staking.rewards.call(provider);

                            let expectedRewards = getExpectedRewards(provider, duration.weeks(1)).add(
                                debt.mul(bestMultiplier).div(PPM_RESOLUTION)
                            );

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, expectedRewards);

                            // Should retroactively apply the three weeks multiplier on the unclaimed rewards.
                            await setTime(now.add(duration.weeks(2)));

                            const multiplier3 = getRewardsMultiplier(duration.weeks(3));
                            bestMultiplier = BN.max(multiplier2, multiplier3);
                            reward = await staking.rewards.call(provider);

                            expectedRewards = getExpectedRewards(provider, duration.weeks(3)).add(
                                debt.mul(bestMultiplier).div(PPM_RESOLUTION)
                            );

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, expectedRewards);
                        });

                        it('should keep all rewards when partially removing liquidity', async () => {
                            // Should return all rewards for four weeks, with the four weeks multiplier bonus
                            await setTime(programStartTime.add(duration.weeks(1)));

                            const unclaimed = await staking.rewards.call(provider);
                            expect(unclaimed).to.be.bignumber.equal(getExpectedRewards(provider, duration.weeks(1)));
                            const debMultiplier = getRewardsMultiplier(duration.weeks(1));
                            const debt = unclaimed.mul(PPM_RESOLUTION).div(debMultiplier);

                            // Remove all the liquidity.
                            const fullAmount = reserveAmounts[poolToken.address][reserveToken.address][provider];
                            const partialAmount = fullAmount.div(new BN(2));
                            const prevBalance = await networkToken.balanceOf.call(provider);
                            await removeLiquidity(provider, poolToken, reserveToken, partialAmount);
                            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance);

                            // Should not affect the claimable amount.
                            let reward = await staking.rewards.call(provider);

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, debt.mul(debMultiplier).div(PPM_RESOLUTION));

                            await setTime(now.add(duration.weeks(2)));

                            // Should retroactively apply the two weeks multiplier on the debt rewards.
                            const multiplier2 = getRewardsMultiplier(duration.weeks(2));
                            let bestMultiplier = BN.max(debMultiplier, multiplier2);
                            reward = await staking.rewards.call(provider);

                            let expectedRewards = getExpectedRewards(provider, duration.weeks(2)).add(
                                debt.mul(bestMultiplier).div(PPM_RESOLUTION)
                            );

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, expectedRewards);

                            // Should retroactively apply the four weeks multiplier on the unclaimed rewards.
                            await setTime(now.add(duration.weeks(2)));

                            const multiplier3 = getRewardsMultiplier(duration.weeks(4));
                            bestMultiplier = BN.max(multiplier2, multiplier3);
                            reward = await staking.rewards.call(provider);

                            expectedRewards = getExpectedRewards(provider, duration.weeks(4)).add(
                                debt.mul(bestMultiplier).div(PPM_RESOLUTION)
                            );

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, expectedRewards);

                            // Remove all the remaining liquidity after two weeks.
                            await setTime(now.add(duration.weeks(2)));

                            const unclaimed2 = await staking.rewards.call(provider);
                            expectAlmostEqual(
                                unclaimed2,
                                getExpectedRewards(provider, duration.weeks(6)).add(
                                    debt.mul(bestMultiplier).div(PPM_RESOLUTION)
                                )
                            );

                            const debMultiplier2 = getRewardsMultiplier(duration.weeks(2));
                            const debt2 = unclaimed2.mul(PPM_RESOLUTION).div(debMultiplier2);

                            const prevBalance2 = await networkToken.balanceOf.call(provider);
                            await removeLiquidity(provider, poolToken, reserveToken, partialAmount);
                            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance2);

                            // Should not affect the claimable amount.
                            reward = await staking.rewards.call(provider);

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, debt2.mul(debMultiplier2).div(PPM_RESOLUTION));

                            await setTime(now.add(duration.weeks(1)));

                            // Should retroactively apply the one weeks multiplier on the debt rewards.
                            const multiplier4 = getRewardsMultiplier(duration.weeks(1));
                            bestMultiplier = BN.max(debMultiplier2, multiplier4);
                            reward = await staking.rewards.call(provider);

                            expectedRewards = getExpectedRewards(provider, duration.weeks(1)).add(
                                debt2.mul(bestMultiplier).div(PPM_RESOLUTION)
                            );

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, expectedRewards);
                        });
                    });

                    describe('claiming', async () => {
                        it('should claim all rewards', async () => {
                            // Should grant all rewards for the duration of one second.
                            await setTime(now.add(duration.seconds(1)));
                            await testClaim(provider);

                            // Should return all rewards for a single day, excluding previously granted rewards.
                            await setTime(programStartTime.add(duration.days(1)));
                            await testClaim(provider);

                            // Should return all weekly rewards, excluding previously granted rewards, but without the
                            // multiplier bonus.
                            await setTime(programStartTime.add(duration.weeks(1)));
                            await testClaim(provider);

                            // Should return all the rewards for the two weeks, excluding previously granted rewards, with the
                            // two weeks rewards multiplier.
                            await setTime(programStartTime.add(duration.weeks(3)));
                            await testClaim(provider, duration.weeks(2));

                            // Should return all program rewards, excluding previously granted rewards + max retroactive
                            // multipliers.
                            await setTime(programEndTime);
                            await testClaim(provider, duration.weeks(4));

                            // Should return no additional rewards after the ending time of the program.
                            await setTime(programEndTime.add(duration.days(1)));
                            await testClaim(provider);
                        });

                        it('should allow claiming rewards after removing liquidity', async () => {
                            // Should return all rewards for four weeks, with the four weeks multiplier bonus
                            await setTime(programStartTime.add(duration.weeks(1)));

                            const unclaimed = await staking.rewards.call(provider);
                            expect(unclaimed).to.be.bignumber.equal(getExpectedRewards(provider, duration.weeks(1)));
                            const debMultiplier = getRewardsMultiplier(duration.weeks(1));
                            const debt = unclaimed.mul(PPM_RESOLUTION).div(debMultiplier);

                            // Remove all the liquidity.
                            const fullAmount = reserveAmounts[poolToken.address][reserveToken.address][provider];
                            const prevBalance = await networkToken.balanceOf.call(provider);
                            await removeLiquidity(provider, poolToken, reserveToken, fullAmount);
                            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance);

                            // Should not affect the claimable amount.
                            let reward = await staking.rewards.call(provider);

                            // take into account that there there might be very small imprecisions when dealing with
                            // multipliers.
                            expectAlmostEqual(reward, debt.mul(debMultiplier).div(PPM_RESOLUTION));

                            const claimed = await staking.claimRewards.call({ from: provider });
                            expect(claimed).to.be.bignumber.equal(reward);
                            const prevBalance2 = await networkToken.balanceOf.call(provider);
                            const tx = await staking.claimRewards({ from: provider });
                            if (claimed.gt(new BN(0))) {
                                expectEvent(tx, 'RewardsClaimed', {
                                    provider,
                                    amount: claimed
                                });
                            }
                            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                                prevBalance2.add(reward)
                            );

                            expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));
                        });
                    });

                    describe('staking', async () => {
                        for (const participating of [false, true]) {
                            context(`${participating ? '' : 'non-'}participating pool`, async () => {
                                let newPoolToken;

                                beforeEach(async () => {
                                    newPoolToken = participating ? poolToken : reserveToken;
                                });

                                it('should partially stake rewards', async () => {
                                    // Should partially claim rewards for the duration of 5 hours.
                                    await setTime(now.add(duration.hours(5)));
                                    let reward = await staking.rewards.call(provider);
                                    expect(reward).to.be.bignumber.equal(
                                        getExpectedRewards(provider, now.sub(prevNow))
                                    );

                                    let amount = reward.div(new BN(3));
                                    while (reward.gt(new BN(0))) {
                                        amount = BN.min(amount, reward);

                                        reward = await testStaking(provider, amount, newPoolToken);
                                    }

                                    expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));

                                    // Should return all rewards for a single day, excluding previously granted rewards.
                                    await setTime(programStartTime.add(duration.days(1)));

                                    reward = await staking.rewards.call(provider);
                                    expect(reward).to.be.bignumber.equal(
                                        getExpectedRewards(provider, now.sub(prevNow))
                                    );

                                    amount = reward.div(new BN(3));
                                    while (reward.gt(new BN(0))) {
                                        amount = BN.min(amount, reward);

                                        reward = await testStaking(provider, amount, newPoolToken);
                                    }

                                    expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));

                                    // Should return all weekly rewards, excluding previously granted rewards, but without the
                                    // multiplier bonus.
                                    await setTime(now.add(duration.weeks(1)));
                                    await testClaim(provider);

                                    // Should return all the rewards for the two weeks, excluding previously granted rewards, with the
                                    // two weeks rewards multiplier.
                                    await setTime(now.add(duration.weeks(2)));

                                    reward = await staking.rewards.call(provider);
                                    expect(reward).to.be.bignumber.equal(
                                        getExpectedRewards(provider, now.sub(prevNow), duration.weeks(2))
                                    );

                                    amount = reward.div(new BN(3));
                                    while (reward.gt(new BN(0))) {
                                        amount = BN.min(amount, reward);

                                        reward = await testStaking(provider, amount, newPoolToken);
                                    }

                                    // Should return all program rewards, excluding previously granted rewards + max retroactive
                                    // multipliers.
                                    await setTime(programEndTime);

                                    reward = await staking.rewards.call(provider);
                                    expect(reward).to.be.bignumber.equal(
                                        getExpectedRewards(provider, now.sub(prevNow), duration.weeks(4))
                                    );

                                    amount = reward.div(new BN(3));
                                    while (reward.gt(new BN(0))) {
                                        amount = BN.min(amount, reward);

                                        reward = await testStaking(provider, amount, newPoolToken);
                                    }
                                });
                            });
                        }

                        it('should not allow staking more than the claimable rewards', async () => {
                            const newPoolToken = accounts[5];

                            await setTime(programStartTime.add(duration.weeks(1)));

                            const reward = await staking.rewards.call(provider);
                            expect(reward).to.be.bignumber.equal(getExpectedRewards(provider, now.sub(prevNow)));

                            const amount = reward.mul(new BN(10000));
                            const data = await staking.stakeRewards.call(amount, newPoolToken, {
                                from: provider
                            });
                            expect(data[0]).to.be.bignumber.equal(reward);

                            const prevProviderBalance = await networkToken.balanceOf.call(provider);
                            const pervLiquidityProtectionBalance = await networkToken.balanceOf.call(
                                liquidityProtection.address
                            );
                            const tx = await staking.stakeRewards(amount, newPoolToken, {
                                from: provider
                            });
                            expectEvent(tx, 'RewardsStaked', {
                                provider,
                                poolToken: newPoolToken,
                                amount: reward,
                                newId: data[1]
                            });

                            expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                                prevProviderBalance
                            );
                            expect(
                                await networkToken.balanceOf.call(liquidityProtection.address)
                            ).to.be.bignumber.equal(pervLiquidityProtectionBalance.add(reward));

                            expect(await liquidityProtection.reserveAmount.call()).to.be.bignumber.equal(reward);

                            expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));
                        });
                    });
                });
            }

            describe('updating rewards', async () => {
                it('should update all rewards for all providers', async () => {
                    // Should grant all rewards for the duration of one second.
                    await setTime(now.add(duration.seconds(1)));
                    await testUpdateRewards(providers);

                    // Should return all rewards for a single day, excluding previously granted rewards.
                    await setTime(programStartTime.add(duration.days(1)));
                    await testUpdateRewards(providers);

                    // Should return all weekly rewards, excluding previously granted rewards, but without the
                    // multiplier bonus.
                    await setTime(programStartTime.add(duration.weeks(1)));
                    await testUpdateRewards(providers);

                    // Should return all the rewards for the two weeks, excluding previously granted rewards, with the
                    // two weeks rewards multiplier.
                    await setTime(programStartTime.add(duration.weeks(3)));
                    await testUpdateRewards(providers, duration.weeks(2));

                    // Should return all program rewards, excluding previously granted rewards + max retroactive
                    // multipliers.
                    await setTime(programEndTime);
                    await testUpdateRewards(providers, duration.weeks(4));

                    // Should return no additional rewards after the ending time of the program.
                    await setTime(programEndTime.add(duration.days(1)));
                    await testUpdateRewards(providers);
                });

                it('should handle claiming for repeated or not participating providers', async () => {
                    await setTime(now.add(duration.seconds(1)));
                    await testUpdateRewards([providers[0], providers[0], providers[0]]);

                    const provider3 = accounts[3];
                    await setTime(programStartTime.add(duration.days(5)));
                    testUpdateRewards([provider3, providers[0], provider3]);
                });
            });
        };

        context('single pool', async () => {
            beforeEach(async () => {
                programStartTime = now.add(duration.weeks(1));
                programEndTime = programStartTime.add(REWARDS_DURATION);

                await setTime(programStartTime);

                await addPoolProgram(poolToken, programEndTime, BIG_POOL_BASE_REWARD_RATE);
                await addLiquidity(
                    providers[0],
                    poolToken,
                    reserveToken,
                    new BN(100000).mul(new BN(10).pow(new BN(18)))
                );
            });

            context('single sided staking', async () => {
                context('single provider', async () => {
                    tests([providers[0]]);
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

                    tests(providers);
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
                    tests([providers[0]]);
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

                    tests(providers);
                });
            });
        });

        context('multiple pools', async () => {
            beforeEach(async () => {
                programStartTime = now.add(duration.weeks(1));
                programEndTime = programStartTime.add(REWARDS_DURATION);

                await setTime(programStartTime);

                await addPoolProgram(poolToken, programEndTime, BIG_POOL_BASE_REWARD_RATE);
                await addPoolProgram(poolToken2, programEndTime, SMALL_POOL_BASE_REWARD_RATE);
                await addPoolProgram(poolToken3, programEndTime, BIG_POOL_BASE_REWARD_RATE);

                await addLiquidity(
                    providers[0],
                    poolToken,
                    reserveToken,
                    new BN(605564).mul(new BN(10).pow(new BN(18)))
                );
                await addLiquidity(
                    providers[0],
                    poolToken2,
                    reserveToken,
                    new BN(11111111111).mul(new BN(10).pow(new BN(18)))
                );
                await addLiquidity(
                    providers[0],
                    poolToken3,
                    reserveToken,
                    new BN(33333333333).mul(new BN(10).pow(new BN(18)))
                );
            });

            context('single sided staking', async () => {
                context('single provider', async () => {
                    tests([providers[0]]);
                });

                context('multiple providers', async () => {
                    beforeEach(async () => {
                        await addLiquidity(
                            providers[1],
                            poolToken,
                            reserveToken,
                            new BN(666666).mul(new BN(10).pow(new BN(18)))
                        );
                        await addLiquidity(
                            providers[1],
                            poolToken2,
                            reserveToken,
                            new BN(88888888).mul(new BN(10).pow(new BN(18)))
                        );
                        await addLiquidity(
                            providers[1],
                            poolToken3,
                            reserveToken,
                            new BN(1111234).mul(new BN(10).pow(new BN(18)))
                        );
                    });

                    tests(providers);
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
                        new BN(888888888).mul(new BN(10).pow(new BN(18)))
                    );
                    await addLiquidity(
                        providers[0],
                        poolToken3,
                        networkToken,
                        new BN(50000).mul(new BN(10).pow(new BN(18)))
                    );
                });

                context('single provider', async () => {
                    tests([providers[0]]);
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
                            poolToken3,
                            reserveToken,
                            new BN(11100008).mul(new BN(10).pow(new BN(18)))
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
                            new BN(234324).mul(new BN(10).pow(new BN(18)))
                        );
                        await addLiquidity(
                            providers[1],
                            poolToken3,
                            networkToken,
                            new BN(100).mul(new BN(10).pow(new BN(18)))
                        );
                    });

                    tests(providers);
                });
            });
        });

        context('pre-existing positions', async () => {
            const provider = accounts[1];

            beforeEach(async () => {
                programStartTime = now.add(duration.years(1));
                programEndTime = programStartTime.add(REWARDS_DURATION);

                expect(await store.isReserveParticipating.call(poolToken3.address, networkToken.address)).to.be.false();
                expect(await store.isReserveParticipating.call(poolToken3.address, reserveToken.address)).to.be.false();
            });

            for (const timeDiff of [duration.days(1), duration.weeks(1), duration.days(180)]) {
                context(`staking ${timeDiff} before the start of the program`, async () => {
                    it('should only take into account staking duration after the start of the program', async () => {
                        await setTime(programStartTime.sub(timeDiff));

                        expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));

                        await addLiquidity(
                            provider,
                            poolToken3,
                            reserveToken,
                            new BN(11100008).mul(new BN(10).pow(new BN(18)))
                        );

                        expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));

                        await setTime(programStartTime);
                        await addPoolProgram(poolToken3, programEndTime, BIG_POOL_BASE_REWARD_RATE);

                        expect(await staking.rewards.call(provider)).to.be.bignumber.equal(new BN(0));

                        await setTime(now.add(duration.days(5)));
                        await testRewards(provider);

                        await setTime(now.add(duration.weeks(1)));
                        await testRewards(provider, duration.weeks(1));
                    });
                });
            }
        });
    });
});
