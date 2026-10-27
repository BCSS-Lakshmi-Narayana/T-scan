/**
 * Seed PolicyMapping categories (BNS legal sections + platform-policy mappings)
 * into the POLICE saga, PER TENANT.
 *
 * Mirrors the political saga's scripts/seed_policy_mappings.js, but the police saga
 * is multi-tenant: each police tenant gets its OWN copy of the 14 categories
 * (tenant_id scoped), so the tenant-facing Policy Manager + per-tenant analysis work.
 *
 * It also migrates the legacy GLOBAL `category_id_1` unique index to a per-tenant
 * compound unique index { tenant_id, category_id } so multiple tenants can share the
 * same category_id values.
 *
 * Run:  node scripts/seed_policy_mappings.js
 *       node scripts/seed_policy_mappings.js --tenant <tenantId|slug>   (single tenant)
 *       node scripts/seed_policy_mappings.js --force                    (overwrite existing)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const { runWithTenant } = require('../src/config/tenantContext');
const { forTenant, dbNameFor } = require('../src/config/tenantConnections');
const PolicyMapping = require('../src/models/PolicyMapping');
const Tenant = require('../src/models/Tenant');

const categories = [
  {
    category_id: 'Communal_Violence',
    definition: 'Promotes or supports physical violence, riots or destruction between religious or communal groups.',
    legal_sections: [
      { id: 'BNS_196', code: '196', title: 'Promoting enmity between groups' },
      { id: 'BNS_351', code: '351', title: 'Criminal intimidation' },
      { id: 'BNS_353_2', code: '353(2)', title: 'Statements conducing to public mischief' }
    ],
    platform_policies: {
      youtube: [{ id: 'VIOLENT_GRAPHIC_CONTENT', name: 'Violent or Graphic Content' }],
      x: [{ id: 'VIOLENT_SPEECH', name: 'Violent Speech' }],
      facebook: [{ id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }],
      instagram: [{ id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }]
    },
    keywords: ['riot', 'communal', 'mob', 'lynch', 'attack community', 'burn', 'violence'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Hate_Speech',
    definition: 'Insults, dehumanises or promotes hatred against a protected group (religion, caste, community, ethnicity, nationality, etc.) without a physical threat.',
    legal_sections: [
      { id: 'BNS_196', code: '196', title: 'Promoting enmity between groups' },
      { id: 'BNS_299', code: '299', title: 'Religious insult' }
    ],
    platform_policies: {
      youtube: [{ id: 'HATE_SPEECH', name: 'Hate Speech' }],
      x: [{ id: 'HATEFUL_CONDUCT', name: 'Hateful Conduct' }],
      facebook: [{ id: 'HATE_SPEECH', name: 'Hate Speech' }],
      instagram: [{ id: 'HATE_SPEECH', name: 'Hate Speech' }]
    },
    keywords: ['hate', 'communal', 'religion', 'caste', 'racist', 'bigot', 'genocide', 'go back', 'kill them'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Hate_Speech_Threat',
    definition: 'Hate speech with a direct or implied physical threat against a protected group.',
    legal_sections: [
      { id: 'BNS_196', code: '196', title: 'Promoting enmity between groups' },
      { id: 'BNS_351', code: '351', title: 'Criminal intimidation' }
    ],
    platform_policies: {
      youtube: [
        { id: 'HATE_SPEECH', name: 'Hate Speech' },
        { id: 'HARASSMENT_CYBERBULLYING', name: 'Harassment & Cyberbullying' }
      ],
      x: [
        { id: 'HATEFUL_CONDUCT', name: 'Hateful Conduct' },
        { id: 'VIOLENT_SPEECH', name: 'Violent Speech' }
      ],
      facebook: [
        { id: 'HATE_SPEECH', name: 'Hate Speech' },
        { id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }
      ],
      instagram: [
        { id: 'HATE_SPEECH', name: 'Hate Speech' },
        { id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }
      ]
    },
    keywords: ['kill them', 'wipe them out', 'drive them out', 'finish them', 'cleanse', 'slaughter'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Hate_Speech_Threat_Extremist',
    definition: 'Hate or violent content supporting extremist, terrorist or organised violent ideology.',
    legal_sections: [
      { id: 'BNS_152', code: '152', title: 'Endangering sovereignty or integrity' },
      { id: 'BNS_196', code: '196', title: 'Promoting enmity between groups' },
      { id: 'BNS_197', code: '197', title: 'Prejudicial to national integration' }
    ],
    platform_policies: {
      youtube: [{ id: 'VIOLENT_CRIMINAL_ORGS', name: 'Violent Criminal Organizations' }],
      x: [{ id: 'VIOLENT_SPEECH', name: 'Violent Speech' }],
      facebook: [{ id: 'DANGEROUS_ORGANIZATIONS', name: 'Dangerous Individuals and Organizations' }],
      instagram: [{ id: 'DANGEROUS_ORGANIZATIONS', name: 'Dangerous Individuals and Organizations' }]
    },
    keywords: ['terrorist', 'terror attack', 'isis', 'bomb blast', 'armed struggle', 'martyrdom'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Harassment',
    definition: 'Targeted hostile or intimidating behaviour against a specific person.',
    legal_sections: [
      { id: 'BNS_352', code: '352', title: 'Intentional insult provoking breach of peace' },
      { id: 'BNS_356', code: '356', title: 'Defamation' }
    ],
    platform_policies: {
      youtube: [{ id: 'HARASSMENT_CYBERBULLYING', name: 'Harassment & Cyberbullying' }],
      x: [{ id: 'ABUSE_HARASSMENT', name: 'Abuse and Harassment' }],
      facebook: [{ id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' }],
      instagram: [{ id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' }]
    },
    keywords: ['harass', 'bully', 'insult', 'threaten', 'stalk', 'abuse'],
    severity_level: 'Medium',
    is_active: true
  },
  {
    category_id: 'Abusive',
    definition: 'Personal insults, profanity or degrading remarks about a person or people (including vulgar family or sexualised slurs in any language), without threats and without protected-group targeting.',
    legal_sections: [
      { id: 'BNS_352', code: '352', title: 'Intentional insult provoking breach of peace' }
    ],
    platform_policies: {
      youtube: [{ id: 'HARASSMENT_CYBERBULLYING', name: 'Harassment & Cyberbullying' }],
      x: [{ id: 'ABUSE_HARASSMENT', name: 'Abuse and Harassment' }],
      facebook: [{ id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' }],
      instagram: [{ id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' }]
    },
    keywords: ['idiot', 'bastard', 'scoundrel', 'shameless', 'moron', 'useless fellow'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Sexual_Harassment',
    definition: 'Unwelcome sexual remarks or sexualised targeting.',
    legal_sections: [
      { id: 'BNS_72', code: '72', title: 'Sexual harassment' },
      { id: 'BNS_74', code: '74', title: 'Outraging modesty' },
      { id: 'BNS_79', code: '79', title: 'Insulting modesty of a woman' }
    ],
    platform_policies: {
      youtube: [{ id: 'HARASSMENT_CYBERBULLYING', name: 'Harassment & Cyberbullying' }],
      x: [
        { id: 'ABUSE_HARASSMENT', name: 'Abuse and Harassment' },
        { id: 'SENSITIVE_MEDIA', name: 'Sensitive Media' }
      ],
      facebook: [
        { id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' },
        { id: 'SEXUAL_EXPLOITATION', name: 'Sexual Exploitation' }
      ],
      instagram: [
        { id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' },
        { id: 'SEXUAL_EXPLOITATION', name: 'Sexual Exploitation' }
      ]
    },
    keywords: ['sexy', 'send nudes', 'eve teasing', 'molest', 'vulgar'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Sexual_Violence',
    definition: 'Threats or support of rape or sexual assault.',
    legal_sections: [
      { id: 'BNS_74', code: '74', title: 'Outraging modesty' },
      { id: 'BNS_351', code: '351', title: 'Criminal intimidation' }
    ],
    platform_policies: {
      youtube: [{ id: 'VIOLENT_GRAPHIC_CONTENT', name: 'Violent or Graphic Content' }],
      x: [
        { id: 'VIOLENT_SPEECH', name: 'Violent Speech' },
        { id: 'SENSITIVE_MEDIA', name: 'Sensitive Media' }
      ],
      facebook: [
        { id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' },
        { id: 'SEXUAL_EXPLOITATION', name: 'Sexual Exploitation' }
      ],
      instagram: [
        { id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' },
        { id: 'SEXUAL_EXPLOITATION', name: 'Sexual Exploitation' }
      ]
    },
    keywords: ['rape', 'gang rape', 'sexual assault', 'molestation'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Sexual',
    definition: 'Sexual references without targeting or coercion.',
    legal_sections: [
      { id: 'BNS_74', code: '74', title: 'Outraging modesty' },
      { id: 'BNS_294', code: '294', title: 'Obscene acts and songs' }
    ],
    platform_policies: {
      youtube: [{ id: 'SEXUAL_CONTENT', name: 'Nudity and Sexual Content' }],
      x: [
        { id: 'SENSITIVE_MEDIA', name: 'Sensitive Media' },
        { id: 'ADULT_CONTENT', name: 'Adult Content' }
      ],
      facebook: [
        { id: 'SEXUAL_ACTIVITY', name: 'Sexual Activity' },
        { id: 'NUDITY', name: 'Adult Nudity' }
      ],
      instagram: [{ id: 'NUDITY', name: 'Nudity and Sexual Activity' }]
    },
    keywords: ['porn', 'nude', 'sex video', 'obscene'],
    severity_level: 'Medium',
    is_active: true
  },
  {
    category_id: 'threat',
    definition: 'Direct threat of physical harm against a person or group (not identity-based).',
    legal_sections: [
      { id: 'BNS_351', code: '351', title: 'Criminal intimidation' }
    ],
    platform_policies: {
      youtube: [{ id: 'HARASSMENT_CYBERBULLYING', name: 'Harassment & Cyberbullying' }],
      x: [{ id: 'VIOLENT_SPEECH', name: 'Violent Speech' }],
      facebook: [{ id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }],
      instagram: [{ id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }]
    },
    keywords: ['threat', 'kill you', 'will attack', 'bomb', 'shoot', 'intimidate'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'threat_incitement',
    definition: 'Urging or mobilising others to commit violence.',
    legal_sections: [
      { id: 'BNS_351', code: '351', title: 'Criminal intimidation' },
      { id: 'BNS_353_2', code: '353(2)', title: 'Statements conducing to public mischief' }
    ],
    platform_policies: {
      youtube: [{ id: 'VIOLENT_GRAPHIC_CONTENT', name: 'Violent or Graphic Content' }],
      x: [{ id: 'VIOLENT_SPEECH', name: 'Violent Speech' }],
      facebook: [{ id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }],
      instagram: [{ id: 'VIOLENCE_INCITEMENT', name: 'Violence and Incitement' }]
    },
    keywords: ['gather at', 'take up arms', 'attack them', 'burn it down', 'teach them a lesson', 'come out on the streets'],
    severity_level: 'High',
    is_active: true
  },
  {
    category_id: 'Misinformation',
    definition: 'False or misleading information presented as fact, especially when likely to deceive the public or cause panic, communal tension, or civic harm.',
    legal_sections: [
      { id: 'BNS_197', code: '197', title: 'Prejudicial to national integration' },
      { id: 'BNS_353_2', code: '353(2)', title: 'Statements conducing to public mischief' }
    ],
    platform_policies: {
      youtube: [{ id: 'MISINFORMATION', name: 'Misinformation' }],
      x: [{ id: 'CIVIC_INTEGRITY', name: 'Civic Integrity' }],
      facebook: [{ id: 'MISINFORMATION', name: 'Misinformation' }],
      instagram: [{ id: 'MISINFORMATION', name: 'Misinformation' }]
    },
    keywords: ['fake news', 'rumour', 'rumor', 'false claim', 'hoax', 'misleading', 'propaganda', 'deepfake'],
    severity_level: 'Medium',
    is_active: true
  },
  {
    category_id: 'Defamation',
    definition: 'Content intended to damage the good reputation of a person or institution by publishing false or malicious allegations.',
    legal_sections: [
      { id: 'BNS_356', code: '356', title: 'Defamation' }
    ],
    platform_policies: {
      youtube: [{ id: 'HARASSMENT_CYBERBULLYING', name: 'Harassment & Cyberbullying' }],
      x: [{ id: 'ABUSE_HARASSMENT', name: 'Abuse and Harassment' }],
      facebook: [{ id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' }],
      instagram: [{ id: 'BULLYING_HARASSMENT', name: 'Bullying and Harassment' }]
    },
    keywords: ['defame', 'defamation', 'slander', 'libel', 'character assassination', 'false allegation', 'smear'],
    severity_level: 'Medium',
    is_active: true
  },
  {
    category_id: 'Normal',
    definition: 'News, complaints, political messaging, slogans, lyrics, praise, opinions or neutral discussion without abuse, threats, hate, sexual targeting or misinformation.',
    legal_sections: [],
    platform_policies: {
      youtube: [],
      x: [],
      facebook: [],
      instagram: []
    },
    keywords: [],
    severity_level: 'Low',
    is_active: true
  }
];

// Migrate the legacy GLOBAL unique index (category_id_1) → per-tenant compound unique.
// Runs inside a tenant scope, so it touches that tenant's own database.
async function migrateIndexes() {
  const coll = PolicyMapping.collection;
  const existing = await coll.indexes().catch(() => []); // collection may not exist yet
  const legacy = existing.find((i) => i.name === 'category_id_1');
  if (legacy) {
    await coll.dropIndex('category_id_1');
    console.log('  migrated: dropped legacy global unique index category_id_1');
  }
  // Ensure the per-tenant compound unique index exists.
  await coll.createIndex({ tenant_id: 1, category_id: 1 }, { unique: true });
  console.log('  ensured: { tenant_id, category_id } unique index');
}

async function seed() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const tenantArgIdx = args.indexOf('--tenant');
  const tenantArg = tenantArgIdx >= 0 ? args[tenantArgIdx + 1] : null;

  try {
    await connectDB();
    console.log(`Connected to MongoDB (control plane: ${process.env.DB_NAME})`);

    // Resolve target tenants. Default: ALL police tenants.
    let tenantQuery = { type: 'police' };
    if (tenantArg) {
      tenantQuery = { type: 'police', $or: [{ id: tenantArg }, { slug: tenantArg }] };
    }
    const tenants = await Tenant.find(tenantQuery).select('id slug name type db_name').lean();
    if (tenants.length === 0) {
      console.error('No matching police tenants found. Nothing to seed.');
      process.exit(1);
    }

    let totalInserted = 0, totalUpdated = 0, totalSkipped = 0;

    for (const t of tenants) {
      console.log(`\nTenant: ${t.slug} (${t.id}) → ${dbNameFor(t)}`);
      // Each tenant's mappings live in that tenant's own database.
      await runWithTenant({ tenant: t, tenantId: t.id, connection: forTenant(t) }, async () => {
      await migrateIndexes();
      for (const cat of categories) {
        const existing = await PolicyMapping.findOne({ tenant_id: t.id, category_id: cat.category_id });
        if (existing) {
          if (force) {
            existing.set({ ...cat });
            await existing.save();
            console.log(`  UPDATE ${cat.category_id}`);
            totalUpdated++;
          } else {
            console.log(`  SKIP   ${cat.category_id} (exists)`);
            totalSkipped++;
          }
        } else {
          await PolicyMapping.create({ ...cat, tenant_id: t.id });
          console.log(`  INSERT ${cat.category_id}`);
          totalInserted++;
        }
      }
      });
    }

    console.log(`\nDone — tenants: ${tenants.length}, inserted: ${totalInserted}, updated: ${totalUpdated}, skipped: ${totalSkipped}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
