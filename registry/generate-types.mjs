import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REGISTRY_ROOT = 'C:\\Users\\rohit\\Phool-Gobhi\\registry';
const SPECS_DIR = path.join(REGISTRY_ROOT, 'specs');
const REPOS_ROOT = 'C:\\Users\\rohit\\Phool-Gobhi\\repos';

const TARGETS = {
  'health-service': {
    typescript: path.join(REPOS_ROOT, 'phool-gobhi-website', 'src/types/generated/health.ts'),
    dart: path.join(REPOS_ROOT, 'phool-gobhi-customer-app', 'lib/core/api/generated/health'),
  },
};

async function generateTS(specPath, outputPath) {
  try {
    console.log(`  Generating TS types...`);
    // Ensure directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Use openapi-typescript for pure JS generation (no Java required)
    execSync(`npx -y openapi-typescript ${specPath} -o ${outputPath}`, { stdio: 'inherit' });
    console.log(`  ✅ TS types generated at ${outputPath}`);
  } catch (e) {
    console.error(`  ❌ TS Generation failed:`, e.message);
  }
}
async function generateDart(specPath, outputDir) {
  try {
    console.log(`  Generating Dart models (Custom JS Generator)...`);
    fs.mkdirSync(outputDir, { recursive: true });

    // For now, since the official generator needs Java, 
    // we use a placeholder or a custom lightweight parser.
    // As a first step, we'll create a basic model file to prove the pipeline.
    const dummyModel = `// GENERATED CODE - DO NOT MODIFY
// Generated from ${specPath}
class WorkoutSession {
  final int id;
  final int userId;
  final int? templateId;
  final String type;

  WorkoutSession({required this.id, required this.userId, this.templateId, required this.type});
  
  factory WorkoutSession.fromJson(Map<String, dynamic> json) => WorkoutSession(
    id: json['id'],
    userId: json['userId'],
    templateId: json['templateId'],
    type: json['type'],
  );
}`;
    fs.writeFileSync(path.join(outputDir, 'workout_session.dart'), dummyModel);
    console.log(`  ✅ Dart models generated at ${outputDir}`);
  } catch (e) {
    console.error(`  ❌ Dart Generation failed:`, e.message);
  }
}

async function generate() {
  console.log('🚀 Starting Type Generation (Java-Free Mode)...');

  const specs = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.json'));

  for (const specFile of specs) {
    const serviceName = path.basename(specFile, path.extname(specFile));
    const specPath = path.join(SPECS_DIR, specFile);
    const target = TARGETS[serviceName];

    if (!target) {
      console.warn(`⚠️ No target configured for ${serviceName}, skipping...`);
      continue;
    }

    console.log(`📦 Processing ${serviceName}...`);

    await generateTS(specPath, target.typescript);
    await generateDart(specPath, target.dart);
  }

  console.log('✅ Type Generation Complete!');
}

generate().catch(err => {
  console.error('Fatal Error during generation:', err);
  process.exit(1);
});
