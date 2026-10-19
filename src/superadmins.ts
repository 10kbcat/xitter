export type Superadmin = { readonly instance: string; readonly screen_name: string; readonly instance_key: string | null };

const HARDCODED: readonly Superadmin[] = [{ instance: "xitter.opuadm.com", screen_name: "meow", instance_key: null }];

const testing = process.env.FEDERATION_ALLOW_HTTP && process.env.XITTER_TEST_SUPERADMINS;

export const SUPERADMINS: readonly Superadmin[] = Object.freeze(
	(testing
		? String(testing)
				.split(",")
				.map((s) => {
					const [screen_name, instance] = s.trim().split("@");
					return { instance, screen_name, instance_key: null };
				})
		: HARDCODED
	).map((s) => Object.freeze({ ...s })),
);

export const isSuperadminHome = (instance: string) => SUPERADMINS.some((s) => s.instance === instance);

export const superadminOf = (instance: string, screenName: string) =>
	SUPERADMINS.find((s) => s.instance === instance && s.screen_name.toLowerCase() === screenName.toLowerCase());

export const pinnedHomeKey = (instance: string) => SUPERADMINS.find((s) => s.instance === instance && s.instance_key)?.instance_key ?? undefined;
