/** Every CI configuration format Preflight recognises. */
export const CI_GLOBS = [
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  'Jenkinsfile',
  '**/Jenkinsfile',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  '.azure-pipelines/**/*.yml',
  '.circleci/config.yml',
  'bitbucket-pipelines.yml',
];

/** Files that reference GitHub Actions with `uses:`. */
export const CI_ACTION_GLOBS = ['.github/workflows/*.yml', '.github/workflows/*.yaml', '.github/actions/**/action.yml', '.github/actions/**/action.yaml', 'action.yml', 'action.yaml'];
