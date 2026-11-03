import { describe, expect, it } from 'vitest';
import { describeFramework, detectTestFramework, nearestFile } from '../src/fix/testFramework';
import { expectedTestName } from '../src/fix/planner';
import { isTestPath } from '../src/skills/rules/technology';
import { fakeRepo } from './helpers/fakeRepo';

const detect = async (files: Record<string, string>, source: string) => {
  const fw = await detectTestFramework(fakeRepo({ [source]: '', ...files }), source);
  return fw && describeFramework(fw);
};

describe('detectTestFramework', () => {
  it('reads JavaScript and TypeScript runners from the nearest package.json', async () => {
    expect(await detect({ 'package.json': '{"devDependencies":{"vitest":"^2"}}' }, 'src/a.ts')).toBe('Vitest (package.json)');
    expect(await detect({ 'package.json': '{"devDependencies":{"jest":"^29","ts-jest":"^29"}}' }, 'src/a.ts')).toBe('Jest (package.json)');
    expect(await detect({ 'package.json': '{"devDependencies":{"mocha":"^10","chai":"^4"}}' }, 'lib/a.js')).toBe('Mocha (package.json)');
    expect(await detect({ 'package.json': '{"scripts":{"test":"node --test"}}' }, 'lib/a.js')).toBe('node:test (package.json)');
    expect(await detect({ 'package.json': '{"dependencies":{}}' }, 'lib/a.js')).toBe('node:test (default)');
  });

  it('uses the package nearest to the file in a monorepo', async () => {
    const files = {
      'package.json': '{"devDependencies":{"jest":"^29"}}',
      'packages/api/package.json': '{"devDependencies":{"vitest":"^2"}}',
    };
    expect(await detect(files, 'packages/api/src/server.ts')).toBe('Vitest (packages/api/package.json)');
    expect(await detect(files, 'packages/web/src/app.ts')).toBe('Jest (package.json)');
  });

  it('detects Python, JVM, Go, .NET and others', async () => {
    expect(await detect({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }, 'app/models.py')).toBe('pytest (pyproject.toml)');
    expect(await detect({ 'requirements.txt': 'flask\n' }, 'app/models.py')).toBe('unittest (default)');
    expect(await detect({ 'pom.xml': '<artifactId>junit-jupiter</artifactId><artifactId>mockito-core</artifactId>' }, 'src/main/java/Foo.java')).toBe('JUnit 5 (pom.xml)');
    expect(await detect({ 'build.gradle': "testImplementation 'junit:junit:4.13.2'" }, 'src/main/java/Foo.java')).toBe('JUnit 4 (build.gradle)');
    expect(await detect({ 'build.gradle.kts': 'testImplementation("io.kotest:kotest-runner-junit5:5.8.0")' }, 'src/main/kotlin/Foo.kt')).toBe('Kotest (build.gradle.kts)');
    expect(await detect({ 'go.mod': 'require github.com/stretchr/testify v1.9.0' }, 'pkg/store/store.go')).toBe('testify (go.mod)');
    expect(await detect({ 'go.mod': 'module x' }, 'pkg/store/store.go')).toBe('testing (default)');
    expect(await detect({ 'src/Api/Api.csproj': '<PackageReference Include="xunit" />' }, 'src/Api/Controllers/Users.cs')).toBe('xUnit (src/Api/Api.csproj)');
    expect(await detect({ 'Gemfile': "gem 'rspec'" }, 'lib/thing.rb')).toBe('RSpec (Gemfile)');
    expect(await detect({ 'composer.json': '{"require-dev":{"phpunit/phpunit":"^10"}}' }, 'src/Thing.php')).toBe('PHPUnit (composer.json)');
    expect(await detect({ 'CMakeLists.txt': 'find_package(GTest REQUIRED)' }, 'src/parser.cpp')).toBe('GoogleTest (CMakeLists.txt)');
    expect(await detect({}, 'Sources/App/Model.swift')).toBe('XCTest (default)');
    expect(await detect({ 'pubspec.yaml': 'dev_dependencies:\n  flutter_test:\n    sdk: flutter' }, 'lib/main_screen.dart')).toBe('flutter_test (pubspec.yaml)');
  });

  it('gives the AI a concrete hint, and says when it fell back to a default', async () => {
    const vitest = await detectTestFramework(fakeRepo({ 'package.json': '{"devDependencies":{"vitest":"1"}}', 'src/a.ts': '' }), 'src/a.ts');
    expect(vitest?.hint).toMatch(/from 'vitest'/);
    const fallback = await detectTestFramework(fakeRepo({ 'src/a.py': '' }), 'src/a.py');
    expect(fallback?.hint).toMatch(/No test framework is declared, so use this one; it needs no new dependencies/);
  });

  it('walks up folders to the repo root', () => {
    const ctx = fakeRepo({ 'a/package.json': '', 'a/b/c/x.ts': '' });
    expect(nearestFile(ctx, 'a/b/c/x.ts', ['package.json'])).toBe('a/package.json');
    expect(nearestFile(ctx, 'z/x.ts', ['package.json'])).toBeUndefined();
  });
});

describe('test file recognition', () => {
  it('recognises each language convention, case-correctly', () => {
    for (const t of ['src/a.test.ts', 'src/a.spec.js', 'test_parser.py', 'pkg/store_test.go', 'src/test/java/FooTest.java', 'FooTests.swift', 'BarTest.kt', 'BazTest.php', 'thing_spec.rb', 'tests/anything.py', 'UsersTests.cs', 'parser_test.cpp']) {
      expect(isTestPath(t), t).toBe(true);
    }
    for (const s of ['src/main/java/Latest.java', 'src/Contest.kt', 'src/attest.ts', 'src/protester.py', 'src/latest.go']) {
      expect(isTestPath(s), s).toBe(false);
    }
  });

  it('names Swift and C/C++ tests the conventional way', () => {
    expect(['Model.swift', 'parser.cpp', 'util.c', 'api.h'].map(expectedTestName)).toEqual(['ModelTests.swift', 'parser_test.cpp', 'util_test.c', 'api_test.c']);
  });
});
