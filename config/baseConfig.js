// Base Network Configuration for CoffyCoin
// Updated: 2026-03-03
import CoffyCoreABI from './CoffyCoreABI.json';
import GameModuleABI from './GameModuleABI.json';
import ActivityModuleABI from './ActivityModuleABI.json';

export const BASE_CONFIG = {
    // Network Info
    CHAIN_ID: 8453,
    CHAIN_ID_HEX: '0x2105',
    CHAIN_NAME: 'Base Mainnet',
    RPC_URL: 'https://mainnet.base.org',
    EXPLORER_URL: 'https://basescan.org',
    EXPLORER_NAME: 'BaseScan',
    NATIVE_CURRENCY: {
        name: 'Ethereum',
        symbol: 'ETH',
        decimals: 18
    },

    // Contract Addresses
    CONTRACTS: {
        CoffyCore: '0x29248bA2420757bF50595Af6d8903E5d8Dcb9b41',
        GameModule: '0xEb00A304DD1aB9A5bC995d4eD9cAFc190bC593Ea',
        ActivityModule: '0x1084Ba72eaF89E4Ed0c0320FDB4C6A51159c15eb'
    }
};

export const COFFY_CORE_ABI = CoffyCoreABI;
export const GAME_MODULE_ABI = GameModuleABI;
export const ACTIVITY_MODULE_ABI = ActivityModuleABI;
