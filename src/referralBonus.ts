import {
  ReferralBonusGiven as ReferralBonusGivenEvent
} from "../generated/templates/PackSaleTier/SwappingPackSale"

import {
  Referral,
  Referrer,
  ReferrerBonus,
  ReferrerTotal
} from "../generated/schema"

import { BigInt, store } from "@graphprotocol/graph-ts"

export function handleReferralBonus (event: ReferralBonusGivenEvent): void
{

}
