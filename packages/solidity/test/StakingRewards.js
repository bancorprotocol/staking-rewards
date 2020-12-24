const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');
const humanizeDuration = require('humanize-duration');

const { ZERO_ADDRESS } = constants;
const { duration } = time;

const TestERC20Token = contract.fromArtifact('TestERC20Token');
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

const MAX_REWARDS = new BN(1000000000).mul(new BN(10).pow(new BN(18)));

const PPM_RESOLUTION = new BN(1000000);
const MULTIPLIER_INCREMENT = PPM_RESOLUTION.div(new BN(4)); // 25%
const REWARDS_DURATION = duration.weeks(12);
const BIG_POOL_REWARD_RATE = new BN(200000)
    .div(new BN(2))
    .mul(new BN(10).pow(new BN(18)))
    .div(duration.weeks(1));
const SMALL_POOL_REWARD_RATE = new BN(20000)
    .div(new BN(2))
    .mul(new BN(10).pow(new BN(18)))
    .div(duration.weeks(1));

const expectEqualArrays = (arr1, arr2) => {
    expect(arr1.map((x) => x.toString())).to.be.equalTo(arr2.map((x) => x.toString()));
};

describe('StakingRewards', () => {
    let now;
    let contractRegistry;
    let reserveToken;
    let reserveToken2;
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
        now = time;

        for (const t of [checkpointStore, store, staking]) {
            if (t) {
                await t.setTime(now);
            }
        }
    };

    const getProviderRewards = async (provider, poolToken, reserveToken) => {
        const data = await staking.providerRewards.call(provider, poolToken, reserveToken);
        return {
            rewardPerToken: data[0],
            pendingBaseRewards: data[1],
            effectiveStakingTime: data[2]
        };
    };

    const getPoolRewards = async (poolToken, reserveToken) => {
        const data = await staking.poolRewards.call(poolToken, reserveToken);
        return {
            lastUpdateTime: data[0],
            rewardPerToken: data[1]
        };
    };

    beforeEach(async () => {
        contractRegistry = await ContractRegistry.new();

        networkToken = await TestERC20Token.new('TKN1', 'TKN1');

        reserveToken = await TestERC20Token.new('RSV1', 'RSV1');
        reserveToken2 = await TestERC20Token.new('RSV2', 'RSV2');

        poolToken = await TestERC20Token.new('POOL1', 'POOL1');
        poolToken2 = await TestERC20Token.new('POOL2', 'POOL2');

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

    describe.only('notifications', async () => {
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

        it('should reflect on provider and total reserve amounts', async () => {
            // Check the initial state.
            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));

            // Add some liquidity for the first provider.
            const amount = new BN(1000);
            await staking.addLiquidity(provider, poolToken.address, reserveToken.address, 0, amount, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount);
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount);

            // Add some liquidity for the second provider.
            const amount2 = new BN(12345);
            await staking.addLiquidity(provider2, poolToken.address, reserveToken.address, 0, amount2, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount);
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount.add(amount2));

            // Remove some of first provider's liquidity.
            const removedAmount = new BN(5);
            await staking.removeLiquidity(provider, poolToken.address, reserveToken.address, 0, removedAmount, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount.sub(removedAmount));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount.sub(removedAmount).add(amount2));

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

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);

            // Remove second provider's liquidity.
            await staking.removeLiquidity(provider2, poolToken.address, reserveToken.address, 0, amount2, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
        });
    });

    describe('rewards', async () => {
        let state;
        beforeEach(async () => {
            state = {};
        });

        context('single pool', async () => {
            let programStartTime;
            let programEndTime;

            beforeEach(async () => {
                programStartTime = now;
                programEndTime = programStartTime.add(REWARDS_DURATION);

                await store.addPoolProgram(poolToken.address, programStartTime, programEndTime, BIG_POOL_REWARD_RATE);

                await store.addPoolProgram(
                    poolToken2.address,
                    programStartTime,
                    programEndTime,
                    SMALL_POOL_REWARD_RATE
                );
            });

            context('single provider', async () => {
                const provider = accounts[1];
                const provider2 = accounts[2];

                it.only('should grant all staking rewards', async () => {
                    await liquidityProtection.addLiquidity(
                        provider,
                        poolToken.address,
                        reserveToken.address,
                        new BN(1000)
                    );

                    await liquidityProtection.addLiquidity(
                        provider2,
                        poolToken.address,
                        reserveToken.address,
                        new BN(5000)
                    );

                    const providerReserveAmount = await staking.providerReserveAmount.call(
                        provider,
                        poolToken.address,
                        reserveToken.address
                    );
                    const provider2ReserveAmount = await staking.providerReserveAmount.call(
                        provider2,
                        poolToken.address,
                        reserveToken.address
                    );

                    const totalReserveAmount = await staking.totalReserveAmount.call(
                        poolToken.address,
                        reserveToken.address
                    );
                    const totalReserve2Amount = await staking.totalReserveAmount.call(
                        poolToken.address,
                        reserveToken2.address
                    );

                    console.log('providerReserveAmount', providerReserveAmount.toString());
                    console.log('provider2ReserveAmount', provider2ReserveAmount.toString());
                    console.log('totalReserveAmount', totalReserveAmount.toString());
                    console.log('totalReserve2Amount', totalReserve2Amount.toString());

                    // providerReserveAmount(
                    //     address provider,
                    //     IERC20 poolToken,
                    //     IERC20 reserveToken
                    // ) public view returns (uint256) {
                    //     return _totalProtectedReserveAmountsByProvider[provider][poolToken][reserveToken];
                    // }

                    // function totalReserveAmount

                    let reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    let reward2 = await staking.rewards.call({ from: provider2 });
                    expect(reward2).to.be.bignumber.equal(new BN(0));

                    // let providerRewards = await getProviderRewards(provider, poolToken.address, reserveToken.address);
                    // let rewardPerToken = await staking.rewardPerToken.call(poolToken.address, reserveToken.address);
                    // console.log('rewardPerToken 1', rewardPerToken.toString());

                    // console.log('providerRewards.rewardPerToken 1', providerRewards.rewardPerToken.toString());
                    // console.log('providerRewards.pendingBaseRewards 1', providerRewards.pendingBaseRewards.toString());
                    // console.log(
                    //     'providerRewards.effectiveStakingTime 1',
                    //     providerRewards.effectiveStakingTime.toString()
                    // );

                    await setTime(now.add(new BN(1)));

                    // providerRewards = await getProviderRewards(provider, poolToken.address, reserveToken.address);

                    // console.log('rewardPerToken 2', rewardPerToken.toString());
                    // console.log('providerRewards.rewardPerToken 2', providerRewards.rewardPerToken.toString());
                    // console.log('providerRewards.pendingBaseRewards 2', providerRewards.pendingBaseRewards.toString());
                    // console.log(
                    //     'providerRewards.effectiveStakingTime 2',
                    //     providerRewards.effectiveStakingTime.toString()
                    // );

                    const expectedReward1 = new BN(1000).mul(BIG_POOL_REWARD_RATE.div(new BN(6000)));
                    const expectedReward2 = new BN(5000).mul(BIG_POOL_REWARD_RATE.div(new BN(6000)));

                    console.log('expectedReward1', expectedReward1.toString());
                    console.log('expectedReward2', expectedReward2.toString());
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1);

                    let rewardPerToken = await staking.rewardPerToken.call(poolToken.address, reserveToken.address);
                    console.log('rewardPerToken 2', rewardPerToken.toString());
                    reward2 = await staking.rewards.call({ from: provider2 });
                    expect(reward2).to.be.bignumber.equal(expectedReward2);

                    // await staking.claimRewards({ from: provider });

                    // reward = await staking.rewards.call({ from: provider });
                    // expect(reward).to.be.bignumber.equal(new BN(0));

                    // console.log('Hi!');

                    // await setTime(now.add(new BN(1)));
                    // rewardPerToken = await staking.rewardPerToken.call(poolToken.address, reserveToken.address);
                    // console.log('rewardPerToken 3', rewardPerToken.toString());

                    // reward = await staking.rewards.call({ from: provider });
                    // expect(reward).to.be.bignumber.equal(expectedReward.mul(new BN(2)));

                    // Before ending time
                    // await setTime(programEndTime.sub(new BN(1)));
                    // reward = await staking.rewards.call({ from: provider });
                    // //console.log('reward PRE', reward.toString());

                    // // At ending time

                    // await setTime(programEndTime);

                    // let poolRewards = await getPoolRewards(poolToken.address, reserveToken.address);
                    // console.log('poolRewards.lastUpdateTime 1', poolRewards.lastUpdateTime.toString());
                    // console.log('poolRewards.rewardPerToken 1', poolRewards.rewardPerToken.toString());

                    // rewardPerToken = await staking.rewardPerToken.call(poolToken.address, reserveToken.address);
                    // // console.log('programStartTime', programStartTime.toString());
                    // // console.log('programEndTime', programEndTime.toString());
                    // console.log('BIG_POOL_REWARD_RATE', BIG_POOL_REWARD_RATE.toString());
                    // console.log('BIG_POOL_REWARD_RATE', BIG_POOL_REWARD_RATE.toString());
                    // console.log('REWARDS_DURATION', REWARDS_DURATION.toString());
                    // console.log('rewardPerToken 1', rewardPerToken.toString());

                    // console.log('provider pools', await staking.providerPools.call(provider));

                    // const expectedReward2 = new BN(1000)
                    //     .mul(REWARDS_DURATION.sub(new BN(1)).mul(BIG_POOL_REWARD_RATE).div(new BN(1000)))
                    //     .mul(REWARDS_DURATION.sub(new BN(1)).mul(BIG_POOL_REWARD_RATE).div(new BN(1000)))
                    //     .mul(new BN(2));
                    // console.log('expectedReward2', expectedReward2.toString());
                    // reward = await staking.rewards.call({ from: provider });
                    // expect(reward).to.be.bignumber.equal(expectedReward2);

                    // // After ending time
                    // await setTime(programEndTime.add(new BN(1000)));
                    // reward = await staking.rewards.call({ from: provider });
                    // console.log('reward YYY', reward.toString());
                });
            });
        });

        // multiple pool
    });
});
