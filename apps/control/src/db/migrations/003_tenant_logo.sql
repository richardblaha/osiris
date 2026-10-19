-- A tenant's logo: the version of the image in object storage (tenant-logos/<id>/<version>), or NULL
ALTER TABLE tenants ADD COLUMN logo TEXT;
