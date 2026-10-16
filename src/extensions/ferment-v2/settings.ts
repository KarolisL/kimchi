import { readConfigSetting } from "../../config/settings.js"

export interface FermentV2Settings {
	autoResume: boolean
	maxUnchangedContinuations: number
	maxConsecutiveErrors: number
	defaultTokenBudget: number | undefined
	evaluationTimeoutMs: number
	evaluatorModels: readonly string[]
}

/**
 * Ordered default evaluator models: the first usable entry that is not the
 * implementer's session model wins, so verification is model-diverse out of
 * the box.
 */
export const DEFAULT_FERMENT_V2_EVALUATOR_MODELS: readonly string[] = ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"]

export const DEFAULT_FERMENT_V2_SETTINGS: Readonly<FermentV2Settings> = {
	autoResume: true,
	maxUnchangedContinuations: 3,
	maxConsecutiveErrors: 3,
	defaultTokenBudget: undefined,
	evaluationTimeoutMs: 600_000,
	evaluatorModels: DEFAULT_FERMENT_V2_EVALUATOR_MODELS,
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean"
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyTrimmedStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
	)
}

export function parseFermentV2Settings(raw: unknown): FermentV2Settings {
	const settings: FermentV2Settings = { ...DEFAULT_FERMENT_V2_SETTINGS }
	if (!isPlainObject(raw)) return settings

	if (isBoolean(raw.autoResume)) settings.autoResume = raw.autoResume
	if (isPositiveInteger(raw.maxUnchangedContinuations))
		settings.maxUnchangedContinuations = raw.maxUnchangedContinuations
	if (isPositiveInteger(raw.maxConsecutiveErrors)) settings.maxConsecutiveErrors = raw.maxConsecutiveErrors
	if (isPositiveInteger(raw.defaultTokenBudget)) settings.defaultTokenBudget = raw.defaultTokenBudget
	if (isPositiveInteger(raw.evaluationTimeoutMs)) settings.evaluationTimeoutMs = raw.evaluationTimeoutMs
	if (isNonEmptyTrimmedStringArray(raw.evaluatorModels))
		settings.evaluatorModels = raw.evaluatorModels.map((entry) => entry.trim())

	return settings
}

export function getFermentV2Settings(): FermentV2Settings {
	const raw = readConfigSetting("fermentV2", isPlainObject)
	return parseFermentV2Settings(raw)
}
