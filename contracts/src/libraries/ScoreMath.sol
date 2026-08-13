// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Outcome} from "./Types.sol";

/// @title ScoreMath
/// @notice Capital-weighted EWMA scoring with time decay toward neutral.
/// @dev All scores are in basis points of a 0..10000 range. NEUTRAL is the score a
///      brand-new agent starts at and the value an inactive agent decays back to.
library ScoreMath {
    uint32 internal constant MAX_SCORE = 10_000;
    uint32 internal constant NEUTRAL = 5_000;

    /// @notice Decay a score toward NEUTRAL with a fixed half-life.
    /// @dev Integer halvings for whole half-lives, linear interpolation on the remainder.
    ///      Cheap, monotonic, and accurate to well within a basis point over practical inputs.
    function decay(uint32 score, uint256 elapsed, uint256 halfLife) internal pure returns (uint32) {
        if (halfLife == 0 || elapsed == 0 || score == NEUTRAL) return score;

        bool above = score > NEUTRAL;
        uint256 delta = above ? score - NEUTRAL : NEUTRAL - score;

        uint256 halvings = elapsed / halfLife;
        if (halvings >= 32) return NEUTRAL;
        delta >>= halvings;

        // Linear interpolation across the partial half-life: delta -> delta/2 over one halfLife.
        uint256 remainder = elapsed % halfLife;
        if (remainder != 0) {
            delta -= (delta * remainder) / (2 * halfLife);
        }

        return above ? uint32(NEUTRAL + delta) : uint32(NEUTRAL - delta);
    }

    /// @notice Fold one observation into the score, weighted by capital at risk.
    /// @param score Current (already decayed) score.
    /// @param observedQuality Quality of this execution, 0..MAX_SCORE.
    /// @param weight Capital at risk for this execution, already capped by the caller.
    /// @param halfWeight Notional at which a single observation moves the score halfway to
    ///        `observedQuality`. Larger values make the score slower and harder to grind.
    /// @dev score' = score + (q - score) * weight / (weight + halfWeight)
    ///      With weight == 0 the score is unchanged, so dust executions carry no signal.
    function observe(uint32 score, uint32 observedQuality, uint256 weight, uint256 halfWeight)
        internal
        pure
        returns (uint32)
    {
        if (weight == 0) return score;
        uint256 denominator = weight + halfWeight;

        if (observedQuality >= score) {
            uint256 gain = (uint256(observedQuality - score) * weight) / denominator;
            return uint32(score + gain);
        } else {
            uint256 loss = (uint256(score - observedQuality) * weight) / denominator;
            return uint32(score - loss);
        }
    }

    /// @notice Apply a multiplicative haircut, used for faults rather than ordinary outcomes.
    /// @dev Faults bypass the EWMA entirely — a liveness failure or a lost challenge should not
    ///      be smoothed away by a large volume of routine successes.
    function haircut(uint32 score, uint32 haircutBps) internal pure returns (uint32) {
        if (haircutBps >= 10_000) return 0;
        return uint32((uint256(score) * (10_000 - haircutBps)) / 10_000);
    }

    /// @notice Map a settled outcome to a per-execution quality value.
    /// @dev Deliberately not linear in P&L. Rewarding raw profit would reward taking risk with
    ///      other people's capital; the protocol scores *adherence*, and lets consumers price
    ///      returns themselves. Losses are only penalised once they exceed a declared tolerance.
    /// @param lossToleranceBps Downside the agent declared as within-spec, in bps of notional.
    function quality(Outcome memory outcome, uint32 lossToleranceBps) internal pure returns (uint32) {
        uint256 q = MAX_SCORE;

        if (outcome.slaBreached) {
            q = (q * 5_000) / 10_000; // late or out of spec — halve
        }
        if (outcome.limitBreached) {
            q = (q * 2_000) / 10_000; // exceeded declared risk limits — severe
        }

        if (outcome.realizedPnlBps < 0) {
            uint256 loss = uint256(-outcome.realizedPnlBps);
            if (loss > lossToleranceBps) {
                uint256 excess = loss - lossToleranceBps;
                // Full penalty once the excess loss reaches 2x the declared tolerance.
                uint256 span = uint256(lossToleranceBps) * 2;
                uint256 penaltyBps = span == 0 ? 10_000 : (excess * 10_000) / span;
                if (penaltyBps > 10_000) penaltyBps = 10_000;
                q = (q * (10_000 - penaltyBps)) / 10_000;
            }
        }

        return uint32(q);
    }
}
