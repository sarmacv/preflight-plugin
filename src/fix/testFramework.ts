// Works out which test framework a source file's tests should use, from the build file nearest to it,
// so the Coverage PR writes tests the repository can actually run.
import type { RepoContext } from '../engine/context';
import { sourceLanguage } from '../skills/rules/technology';

export interface TestFramework {
  language: string;
  /** Display name, e.g. "Vitest" or "JUnit 5". */
  name: string;
  /** How to write a test with it, handed to the AI. */
  hint: string;
  /** Build file it was detected from; undefined when falling back to the language default. */
  detectedFrom?: string;
}

/** The closest file named one of `names`, walking up from the source's folder to the repo root. */
export function nearestFile(ctx: RepoContext, source: string, names: string[] | ((dir: string) => string[])): string | undefined {
  const parts = source.split('/').slice(0, -1);
  for (let i = parts.length; i >= 0; i--) {
    const dir = parts.slice(0, i).join('/');
    const prefix = dir ? `${dir}/` : '';
    const candidates = typeof names === 'function' ? names(prefix) : names.map((n) => `${prefix}${n}`);
    const found = candidates.map((c) => ctx.exists(c)).find((c): c is string => !!c);
    if (found) return found;
  }
  return undefined;
}

const has = (text: string | undefined, re: RegExp) => !!text && re.test(text);

interface Rule {
  name: string;
  match: RegExp;
  hint: string;
}

function pick(language: string, text: string | undefined, file: string | undefined, rules: Rule[], fallback: Omit<Rule, 'match'>): TestFramework {
  const hit = rules.find((r) => has(text, r.match));
  return hit
    ? { language, name: hit.name, hint: hit.hint, detectedFrom: file }
    : { language, name: fallback.name, hint: `${fallback.hint} No test framework is declared${file ? ` in ${file}` : ''}, so use this one; it needs no new dependencies.` };
}

const JS_RULES: Rule[] = [
  { name: 'Vitest', match: /"vitest"|\bvitest\b/, hint: "Import describe, it, expect and vi from 'vitest'. Mock modules with vi.mock." },
  { name: 'Jest', match: /"jest"|"ts-jest"|"@jest\/|\bjest\b/, hint: 'Use the Jest globals describe, it, expect and jest.mock / jest.fn. Do not import them.' },
  { name: 'Mocha', match: /"mocha"|\bmocha\b/, hint: "Use Mocha's describe and it, with assertions from 'chai' if it is a dependency, otherwise node:assert/strict." },
  { name: 'Jasmine', match: /"jasmine"|\bjasmine\b/, hint: "Use Jasmine's describe, it, expect and spyOn globals." },
  { name: 'AVA', match: /"ava"/, hint: "Import test from 'ava' and use t.is / t.deepEqual." },
  { name: 'node:test', match: /node --test|"node:test"/, hint: "Import { test, describe } from 'node:test' and assert from 'node:assert/strict'." },
];

const PY_RULES: Rule[] = [
  { name: 'pytest', match: /\bpytest\b/, hint: 'Write plain test_ functions with assert statements and pytest fixtures; use pytest.raises for errors and monkeypatch or unittest.mock for I/O.' },
];

const JVM_RULES: Rule[] = [
  { name: 'Kotest', match: /io\.kotest|kotest-/, hint: 'Use a Kotest spec class (e.g. StringSpec or FunSpec) with shouldBe matchers.' },
  { name: 'TestNG', match: /org\.testng|testng/, hint: 'Use TestNG @Test methods and org.testng.Assert.' },
  { name: 'JUnit 5', match: /junit-jupiter|org\.junit\.jupiter|junit-bom|junit:5|useJUnitPlatform/, hint: 'Use JUnit 5: org.junit.jupiter.api.Test and Assertions.*.' },
  { name: 'JUnit 4', match: /<artifactId>junit<\/artifactId>|junit:junit|['"]junit:junit/, hint: 'Use JUnit 4: org.junit.Test and org.junit.Assert.*.' },
];

const GO_RULES: Rule[] = [
  { name: 'testify', match: /github\.com\/stretchr\/testify/, hint: 'Use the standard testing package with github.com/stretchr/testify/assert and require. Prefer table-driven tests.' },
];

const CS_RULES: Rule[] = [
  { name: 'xUnit', match: /xunit/i, hint: 'Use xUnit [Fact] and [Theory] with Assert.*.' },
  { name: 'NUnit', match: /nunit/i, hint: 'Use NUnit [TestFixture] and [Test] with Assert.That.' },
  { name: 'MSTest', match: /MSTest/i, hint: 'Use MSTest [TestClass] and [TestMethod] with Assert.*.' },
];

const RUBY_RULES: Rule[] = [{ name: 'RSpec', match: /rspec/, hint: 'Use RSpec describe / it blocks with expect(...).to matchers.' }];
const PHP_RULES: Rule[] = [
  { name: 'Pest', match: /pestphp\/pest/, hint: 'Use Pest test() / it() functions with expect().' },
  { name: 'PHPUnit', match: /phpunit\/phpunit/, hint: 'Extend PHPUnit\\Framework\\TestCase with test* methods and $this->assert*.' },
];
const SWIFT_RULES: Rule[] = [{ name: 'Swift Testing', match: /swift-testing|import Testing/, hint: 'Use the Swift Testing framework: import Testing, @Test functions and #expect.' }];
const CPP_RULES: Rule[] = [
  { name: 'GoogleTest', match: /gtest|googletest|GTest/, hint: 'Use GoogleTest TEST() / TEST_F() macros with EXPECT_* and ASSERT_*.' },
  { name: 'Catch2', match: /catch2|Catch2/, hint: 'Use Catch2 TEST_CASE / SECTION with REQUIRE and CHECK.' },
];
const DART_RULES: Rule[] = [
  { name: 'flutter_test', match: /flutter_test/, hint: "Import 'package:flutter_test/flutter_test.dart' and use test / testWidgets with expect." },
  { name: 'package:test', match: /\btest:/, hint: "Import 'package:test/test.dart' and use group / test with expect." },
];

/** Detects the framework for one source file; cached per build file so a large run reads each once. */
export async function detectTestFramework(ctx: RepoContext, source: string): Promise<TestFramework | undefined> {
  const language = sourceLanguage(source);
  if (!language) return undefined;
  const read = (file: string | undefined) => (file ? ctx.read(file) : Promise.resolve(undefined));

  switch (language) {
    case 'TypeScript':
    case 'JavaScript': {
      const file = nearestFile(ctx, source, ['package.json']);
      return pick(language, await read(file), file, JS_RULES, {
        name: 'node:test',
        hint: "Use the built-in runner: import { test, describe } from 'node:test' and assert from 'node:assert/strict'.",
      });
    }
    case 'Python': {
      const file = nearestFile(ctx, source, ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'requirements-dev.txt', 'requirements.txt', 'Pipfile']);
      return pick(language, await read(file), file, PY_RULES, {
        name: 'unittest',
        hint: 'Use the standard library unittest: a unittest.TestCase subclass with self.assert* methods, and unittest.mock for I/O.',
      });
    }
    case 'Java':
    case 'Kotlin':
    case 'Scala':
    case 'Groovy': {
      const file = nearestFile(ctx, source, ['pom.xml', 'build.gradle.kts', 'build.gradle', 'build.sbt']);
      const text = await read(file);
      const fw = pick(language, text, file, JVM_RULES, { name: 'JUnit 5', hint: 'Use JUnit 5: org.junit.jupiter.api.Test and Assertions.*.' });
      return has(text, /mockito/i) ? { ...fw, hint: `${fw.hint} Mockito is available for mocks.` } : fw;
    }
    case 'Go': {
      const file = nearestFile(ctx, source, ['go.mod']);
      return pick(language, await read(file), file, GO_RULES, {
        name: 'testing',
        hint: 'Use the standard testing package: func TestXxx(t *testing.T) with t.Errorf / t.Fatalf. Prefer table-driven tests.',
      });
    }
    case 'C#':
    case 'VB.NET':
    case 'F#': {
      const file = nearestFile(ctx, source, (prefix) => ctx.match([`${prefix}*.csproj`, `${prefix}*.fsproj`, `${prefix}*.vbproj`, `${prefix}Directory.Packages.props`]));
      return pick(language, await read(file), file, CS_RULES, { name: 'xUnit', hint: 'Use xUnit [Fact] and [Theory] with Assert.*.' });
    }
    case 'Ruby': {
      const file = nearestFile(ctx, source, ['Gemfile']);
      return pick(language, await read(file), file, RUBY_RULES, { name: 'Minitest', hint: 'Use Minitest: a Minitest::Test subclass with test_ methods and assert_*.' });
    }
    case 'PHP': {
      const file = nearestFile(ctx, source, ['composer.json']);
      return pick(language, await read(file), file, PHP_RULES, { name: 'PHPUnit', hint: 'Extend PHPUnit\\Framework\\TestCase with test* methods and $this->assert*.' });
    }
    case 'Swift':
    case 'Objective-C': {
      const file = nearestFile(ctx, source, ['Package.swift']);
      return pick(language, await read(file), file, SWIFT_RULES, { name: 'XCTest', hint: 'Use XCTest: an XCTestCase subclass with test methods and XCTAssert*.' });
    }
    case 'C':
    case 'C++': {
      const file = nearestFile(ctx, source, ['CMakeLists.txt', 'conanfile.txt', 'vcpkg.json', 'meson.build']);
      return pick(language, await read(file), file, CPP_RULES, { name: 'GoogleTest', hint: 'Use GoogleTest TEST() macros with EXPECT_* and ASSERT_*.' });
    }
    case 'Rust':
      return {
        language,
        name: 'cargo test',
        hint: 'Write an integration test file under tests/ using #[test] functions and assert! / assert_eq!, calling the crate\'s public API.',
        detectedFrom: nearestFile(ctx, source, ['Cargo.toml']),
      };
    case 'Dart': {
      const file = nearestFile(ctx, source, ['pubspec.yaml']);
      return pick(language, await read(file), file, DART_RULES, { name: 'package:test', hint: "Import 'package:test/test.dart' and use group / test with expect." });
    }
    default:
      return undefined;
  }
}

/** "Vitest (packages/api/package.json)" or "node:test (default)". */
export function describeFramework(fw: TestFramework): string {
  return `${fw.name} (${fw.detectedFrom ?? 'default'})`;
}
