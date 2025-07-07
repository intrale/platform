package ar.com.intrale;

import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbIndex;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.TableSchema;

public class DummyBusinessTable implements DynamoDbTable<Business> {
    public Business item;
    @Override
    public DynamoDbEnhancedClientExtension mapperExtension() { return null; }
    @Override
    public TableSchema<Business> tableSchema() { return TableSchema.fromBean(Business.class); }
    @Override
    public String tableName() { return "business"; }
    @Override
    public Key keyFrom(Business item) { return Key.builder().partitionValue(item.getName()).build(); }
    @Override
    public DynamoDbIndex<Business> index(String indexName) { throw new UnsupportedOperationException(); }
    @Override
    public Business getItem(Key key) {
        return item;
    }
    @Override
    public Business updateItem(Business item) { this.item = item; return item; }
    @Override
    public void putItem(Business item) { this.item = item; }
}
