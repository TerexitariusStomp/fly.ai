from .primitives import USD,SYM,day, PlaceholderTypeDemandSupply
from typing import TypedDict
from .compound import MarketDemandSupply

StateType = TypedDict('StateType', {
                      'reward_rate':float,
                      'liq_stables':USD,
                      'liq_shit':SYM, # same like liq_stables, but in the unit of symbient 
                      'reserves_stables':USD,
                      'treasury_stables':USD,
                      'liq_backing':USD,
                      
                      'supply':SYM,
                      'floating_supply':SYM,
                    #   'price':USD/SYM,
                    #   'ma_target':USD/SYM,
                      'reserves_in':USD,
                      'target_liq_ratio_reached':bool,
                      'ask_change_shit':SYM,
                      'bid_change_shit':SYM,
                      'market_demand_supply': MarketDemandSupply,
                      "net_flow": USD,
                      'amm_k':float,})
ParamsType = TypedDict('ParamsType', {
                        'target_ma':day,
                        'demand_factor': PlaceholderTypeDemandSupply, 'supply_factor': PlaceholderTypeDemandSupply,
                        "reinstate_window": int})
