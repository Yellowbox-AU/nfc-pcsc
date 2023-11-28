// One of these for each .ts source file that is not imported by any other files will ensure we get
// IDE auto-import suggestions. This is not needed for index.ts since it is referenced through the
// main concrete `export from` statement at the end of the file

// /// <reference path="src/index.ts" />

export * from './index'