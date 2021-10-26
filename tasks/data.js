import Listr from "listr";
import { apiV8, apiV9 } from "../api.js";
import { writeErrorLogs } from "../index.js";

export async function migrateData(context) {
	return new Listr([
		{
			title: "Getting Counts",
			task: async () => await getCounts(context),
		},
		{
			title: "Inserting Data",
			task: async () => await insertData(context),
		},
	]);
}

async function getCounts(context) {
	context.counts = {};

	for (const collection of context.collections) {
		const count = await apiV8.get(`/items/${collection.collection}`, {
			params: {
				limit: 1,
				meta: "total_count",
			},
		});

		context.counts[collection.collection] = count.data.meta.total_count;
	}
}

function isJunctionCollection(note) {
	const junctionCollectionNames = [
		"連接點集合",
		"交叉集合",
		"中継コレクション",
		"Узловая Коллекция",
		"Verbindingscollectie",
		"Verbindungssammlung",
		"Збірна колекція",
		"Spojovací kategorie",
		"Junction Collection",
		"Pengumpulan Persimpangan",
		"Kesişim Koleksiyonu",
		"مجموعة تلاقي",
		"Kolekcja Junction",
		"Jução da coleção",
		"Koleksi Persimpangan",
		"Collezione Junction",
		"Colección de empalme",
		"Collection de jonction",
		"Colección de unión",
	];

	return junctionCollectionNames.includes(note);
}

// This is definitely a hack to achieve first adding items of collections that have dependencies in other collections i.e m2m, o2m
// FIXME: Implement a more robust solution to sort collections based on their dependencies, or swap to a different way to seed the data
function moveJunctionCollectionsBack(a,b) {
	if (isJunctionCollection(a.note) || isJunctionCollection(b.note)) {
		if (isJunctionCollection(a.note)) {
			return 1;
		}

		if (isJunctionCollection(b.note)) {
			return -1;
		}
	}

	return 0;
}

function moveManyToOne(a,b) {
	if ( Object.values(a.fields).find(element => element.interface === 'many-to-one') ) {
		return 1;
	}

	if ( Object.values(b.fields).find(element => element.interface === 'many-to-one') ) {
		return -1;
	}

	return 0;
}

function moveByCustomOrder(collectionOrder) {
	return (a, b) => {
		return collectionOrder.indexOf(a.collection) - collectionOrder.indexOf(b.collection);
	}
}

async function insertData(context) {
	let sortedCollections;

	if (process.env.COLLECTION_ORDER) {
		const collectionOrder = process.env.COLLECTION_ORDER
			.split(',')
			.map(entry => entry.trim());
		sortedCollections = context.collections
			.sort(moveByCustomOrder(collectionOrder))
	} else {
		sortedCollections = context.collections
			.sort(moveManyToOne)
			.sort(moveJunctionCollectionsBack)
	}

	return new Listr(
		sortedCollections.map((collection) => ({
			title: collection.collection,
			task: insertCollection(collection),
		}))
	);
}

function insertCollection(collection) {
	return async (context, task) => {
		const pages = Math.ceil(context.counts[collection.collection] / 100);

		for (let i = 0; i < pages; i++) {
			task.output = `Inserting items ${i * 100 + 1}—${(i + 1) * 100}/${
				context.counts[collection.collection]
			}`;
			await insertBatch(collection, i, context, task);
		}
	};
}

async function insertBatch(collection, page, context, task) {
	const getRecordsResponse = () =>
		apiV8.get(`/items/${collection.collection}`, {
			params: {
				offset: page * 100,
				limit: 100,
			},
		});

	let recordsResponse;

	try {
		recordsResponse = await getRecordsResponse();
	} catch {
		// try again hacky hacky. We'll let it crash and burn on a second failure
		await sleep(500);
		recordsResponse = await getRecordsResponse();
	}

	const systemRelationsForCollection = context.relations.filter((relation) => {
		return (
			relation?.meta?.many_collection === collection.collection &&
			relation?.meta?.one_collection.startsWith("directus_")
		);
	});

	const datetimeFields = Object.values(collection.fields).filter(field => field.type === 'datetime')

	const itemRecords =
		systemRelationsForCollection.length === 0 && datetimeFields.length === 0
			? recordsResponse.data.data
			: recordsResponse.data.data.map((item) => {
					for (const systemRelation of systemRelationsForCollection) {
						if (systemRelation?.meta?.one_collection === "directus_users") {
							item[systemRelation?.meta?.many_field] =
								context.userMap[item[systemRelation?.meta?.many_field]];
						} else if (systemRelation?.meta?.one_collection === "directus_files") {
							item[systemRelation?.meta?.many_field] =
								context.fileMap[item[systemRelation?.meta?.many_field]];
						}
					}

					for (const datetimeField of datetimeFields) {
						item[datetimeField.field] = new Date(item[datetimeField.field]).toISOString();
					}

					return item;
			  });

	try {
		if (collection.single === true) {
			await apiV9.patch(`/items/${collection.collection}`, itemRecords[0]);
		} else {
			await apiV9.post(`/items/${collection.collection}`, itemRecords);
		}
	} catch (err) {
		console.log(err.response.data);
		writeErrorLogs("items", err.response);
		// throw Error("Data migration failed. Check directus logs for most insight.")
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
