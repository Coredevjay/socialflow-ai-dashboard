import { generateUploadFilename } from '../uploadStorage';

describe('generateUploadFilename', () => {
  it('uses a UUID and MIME-derived extension', () => {
    const name = generateUploadFilename('image', 'image/png');
    expect(name).toMatch(/^image-[0-9a-f-]{36}\.png$/);
    expect(generateUploadFilename('image', 'image/png')).not.toBe(name);
  });

  it('sanitises the field name and ignores unknown MIME types', () => {
    expect(generateUploadFilename('../x', 'application/x-evil')).toMatch(/^x-[0-9a-f-]{36}\.bin$/);
  });
});
